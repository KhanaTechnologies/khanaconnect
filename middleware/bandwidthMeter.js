const mongoose = require('mongoose');
const BandwidthUsage = require('../models/BandwidthUsage');

/**
 * Bandwidth meter — counts response bytes per route / static file / origin / client / user agent,
 * aggregates in memory and flushes hourly buckets to MongoDB (bandwidth_usage) once a minute.
 *
 * Mount BEFORE compression() so the counted bytes are the compressed bytes that leave the server.
 * attachServer(server) also samples raw socket bytes, which includes Socket.IO / websockets.
 */

const FLUSH_INTERVAL_MS = 60 * 1000;
/** Cap distinct keys per dimension between flushes so bots can't blow up memory. */
const MAX_KEYS_PER_DIM = 400;
const OTHER_KEY = '(other)';

const startedAt = new Date();
let pending = new Map(); // `${bucketMs}|${dim}|${key}` -> { requests, bytesOut, bytesIn }
const pendingKeyCounts = new Map(); // `${bucketMs}|${dim}` -> number of keys
const live = { requests: 0, bytesOut: 0, bytesIn: 0, wireBytesOut: 0 };
let flushTimer = null;
let flushing = false;

function hourBucket(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

function add(bucketMs, dim, key, requests, bytesOut, bytesIn) {
  const dimKey = `${bucketMs}|${dim}`;
  let mapKey = `${dimKey}|${key}`;
  if (!pending.has(mapKey)) {
    const count = pendingKeyCounts.get(dimKey) || 0;
    if (count >= MAX_KEYS_PER_DIM) {
      mapKey = `${dimKey}|${OTHER_KEY}`;
    } else {
      pendingKeyCounts.set(dimKey, count + 1);
    }
  }
  const row = pending.get(mapKey) || { requests: 0, bytesOut: 0, bytesIn: 0 };
  row.requests += requests;
  row.bytesOut += bytesOut;
  row.bytesIn += bytesIn;
  pending.set(mapKey, row);
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_NUM_RE = /^\+?\d{5,}$/;
const TOKEN_RE = /^[A-Za-z0-9_\-.=]{32,}$/;

/** Collapse ids / phone numbers / tokens so routes group together. */
function normalizeRoute(method, rawPath) {
  const pathOnly = String(rawPath || '/').split('?')[0];
  const parts = pathOnly.split('/').map((seg) => {
    if (!seg) return seg;
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch (_) {
      /* keep raw */
    }
    if (OBJECT_ID_RE.test(s)) return ':id';
    if (UUID_RE.test(s)) return ':uuid';
    if (LONG_NUM_RE.test(s)) return ':num';
    if (TOKEN_RE.test(s)) return ':token';
    if (s.startsWith('wamid.')) return ':wamid';
    return seg.length > 60 ? ':long' : seg;
  });
  return `${method} ${parts.join('/') || '/'}`.slice(0, 200);
}

function isStaticPath(p) {
  return p.startsWith('/public/') || p.startsWith('/uploads/');
}

function hostOf(value) {
  if (!value) return '';
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch (_) {
    return '';
  }
}

/** Who is downloading — storefront visitors, email image proxies, crawlers, servers... */
function classifyAgent(uaRaw) {
  const ua = String(uaRaw || '').toLowerCase();
  if (!ua) return 'No user agent';
  if (ua.includes('googleimageproxy')) return 'Gmail image proxy (email opens)';
  if (ua.includes('yahoomailproxy')) return 'Yahoo mail proxy (email opens)';
  if (ua.includes('facebookexternalhit') || ua.includes('facebookcatalog') || ua.includes('meta-externalagent')) {
    return 'Meta / Facebook crawler';
  }
  if (ua.includes('whatsapp')) return 'WhatsApp link preview';
  if (ua.includes('instagram')) return 'Instagram';
  if (ua.includes('googlebot') || ua.includes('google-inspectiontool') || ua.includes('adsbot-google')) return 'Googlebot';
  if (ua.includes('bingbot')) return 'Bingbot';
  if (ua.includes('render') && ua.includes('health')) return 'Render health check';
  if (/(bot|crawler|spider|crawl|slurp|semrush|ahrefs|petalbot|bytespider|gptbot|claudebot)/.test(ua)) {
    return 'Other bots / crawlers';
  }
  if (/(axios|node-fetch|undici|node|python|curl|wget|go-http|okhttp|java|postman|insomnia)/.test(ua)) {
    return 'Server / script (axios, curl, …)';
  }
  if (ua.includes('microsoft outlook') || ua.includes('ms-office')) return 'Outlook (email opens)';
  if (ua.includes('mozilla')) {
    return /(mobile|android|iphone|ipad)/.test(ua) ? 'Browser (mobile)' : 'Browser (desktop)';
  }
  return 'Other';
}

function resolveClientId(req) {
  return String(
    req.tenant?.clientId ||
      req.auth?.clientID ||
      req.auth?.clientId ||
      req.clientId ||
      req.clientID ||
      req.headers['x-client-id'] ||
      ''
  ).trim().slice(0, 80);
}

function byteLen(chunk, encoding) {
  if (!chunk) return 0;
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.length;
  return Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function bandwidthMeter(req, res, next) {
  let bodyBytes = 0;
  const origWrite = res.write;
  const origEnd = res.end;

  res.write = function meteredWrite(chunk, encoding, cb) {
    bodyBytes += byteLen(chunk, encoding);
    return origWrite.call(this, chunk, encoding, cb);
  };
  res.end = function meteredEnd(chunk, encoding, cb) {
    if (chunk && typeof chunk !== 'function') bodyBytes += byteLen(chunk, encoding);
    return origEnd.call(this, chunk, encoding, cb);
  };

  const record = () => {
    res.removeListener('finish', record);
    res.removeListener('close', record);
    try {
      // res._header is the serialized status line + headers once they are sent.
      const headerBytes = typeof res._header === 'string' ? Buffer.byteLength(res._header) : 0;
      const bytesOut = bodyBytes + headerBytes;
      const bytesIn = Number(req.headers['content-length']) || 0;
      const bucket = hourBucket();
      const rawPath = (req.originalUrl || req.url || '/').split('?')[0];
      const origin = hostOf(req.headers.origin) || hostOf(req.headers.referer) || '(no origin — direct / server / email)';
      const clientId = resolveClientId(req) || '(anonymous)';
      const status = `${Math.floor((res.statusCode || 0) / 100)}xx`;

      live.requests += 1;
      live.bytesOut += bytesOut;
      live.bytesIn += bytesIn;

      add(bucket, 'total', 'all', 1, bytesOut, bytesIn);
      if (isStaticPath(rawPath)) {
        add(bucket, 'route', `${req.method} ${rawPath.split('/').slice(0, 3).join('/')}/* (static files)`, 1, bytesOut, bytesIn);
        add(bucket, 'file', rawPath.slice(0, 200), 1, bytesOut, bytesIn);
      } else {
        add(bucket, 'route', normalizeRoute(req.method, rawPath), 1, bytesOut, bytesIn);
      }
      add(bucket, 'origin', origin, 1, bytesOut, bytesIn);
      add(bucket, 'client', clientId, 1, bytesOut, bytesIn);
      add(bucket, 'agent', classifyAgent(req.headers['user-agent']), 1, bytesOut, bytesIn);
      add(bucket, 'status', status, 1, bytesOut, bytesIn);
      if (req.storefrontToken) {
        add(bucket, 'apitoken', `${normalizeRoute(req.method, rawPath)} · ${status}`, 1, bytesOut, bytesIn);
      }
    } catch (err) {
      console.error('[bandwidthMeter] record failed:', err.message);
    }
  };

  res.on('finish', record);
  res.on('close', record);
  next();
}

/**
 * Sample raw bytes written to every TCP socket (HTTP + Socket.IO / websockets).
 * This is the closest number to what Render meters for this service.
 */
const sockets = new Map(); // socket -> bytesWritten already counted

function collectWireBytes(socket) {
  const prev = sockets.get(socket) || 0;
  const now = socket.bytesWritten || 0;
  const delta = now - prev;
  if (delta > 0) {
    live.wireBytesOut += delta;
    add(hourBucket(), 'wire', 'all', 0, delta, 0);
  }
  sockets.set(socket, now);
}

function attachServer(server) {
  server.on('connection', (socket) => {
    sockets.set(socket, 0);
    socket.once('close', () => {
      collectWireBytes(socket);
      sockets.delete(socket);
    });
  });
}

async function flush() {
  for (const socket of sockets.keys()) collectWireBytes(socket);
  if (flushing || !pending.size) return;
  if (mongoose.connection.readyState !== 1) return; // keep accumulating until DB is up

  flushing = true;
  const batch = pending;
  pending = new Map();
  pendingKeyCounts.clear();

  const ops = [];
  for (const [mapKey, row] of batch) {
    const [bucketMs, dim, ...rest] = mapKey.split('|');
    ops.push({
      updateOne: {
        filter: { bucket: new Date(Number(bucketMs)), dim, key: rest.join('|') },
        update: { $inc: { requests: row.requests, bytesOut: row.bytesOut, bytesIn: row.bytesIn } },
        upsert: true,
      },
    });
  }

  try {
    await BandwidthUsage.bulkWrite(ops, { ordered: false });
  } catch (err) {
    console.error('[bandwidthMeter] flush failed:', err.message);
  } finally {
    flushing = false;
  }
}

function startFlushing() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function stopFlushing() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  return flush();
}

function liveStats() {
  return {
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    ...live,
  };
}

module.exports = {
  bandwidthMeter,
  attachServer,
  startFlushing,
  stopFlushing,
  flush,
  liveStats,
  normalizeRoute,
  classifyAgent,
};
