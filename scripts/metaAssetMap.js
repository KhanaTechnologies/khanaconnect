/**
 * Read-only: maps businesses -> pixels/datasets -> ad accounts visible to a client's token,
 * so you can see which Events Manager a pixel actually lives in.
 *
 * Usage: node scripts/metaAssetMap.js [clientID]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { decrypt } = require('../helpers/encryption');

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

function maybeDecrypt(value) {
  if (!value || typeof value !== 'string' || !value.includes(':')) return value;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

async function main() {
  let uri = process.env.CONNECTION_STRING || '';
  if (!/KhanaConnect_ProdDB/.test(uri)) {
    uri = uri.replace(
      '@khanaconnect.mvygpxm.mongodb.net/',
      '@khanaconnect.mvygpxm.mongodb.net/KhanaConnect_ProdDB'
    );
  }
  await mongoose.connect(uri);

  const Client = require('../models/client');
  const doc = await Client.findOne({ clientID: process.argv[2] || 'Khana' });
  const raw = doc.toObject();
  const token = maybeDecrypt(raw.metaAds?.accessToken);
  const pixelId = maybeDecrypt(raw.metaAds?.pixelId);
  const adAccountId = maybeDecrypt(raw.metaAds?.adAccountId);

  const acct = adAccountId
    ? adAccountId.startsWith('act_')
      ? adAccountId
      : `act_${adAccountId}`
    : null;

  const dbg = await graph('debug_token', { input_token: token, access_token: token });
  const d = dbg.body?.data || {};
  console.log(`\n=== Token / app ===`);
  console.log(`  app        : ${d.application || '(unknown)'} (${d.app_id || '-'})`);
  console.log(`  valid      : ${d.is_valid}  expires: ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never'}`);
  console.log(`  scopes     : ${(d.scopes || []).join(', ') || '-'}`);

  if (pixelId) {
    const pix = await graph(pixelId, {
      fields: 'name,owner_business{id,name},last_fired_time,creation_time',
      access_token: token,
    });
    console.log(`\n=== Destination pixel ${pixelId} ===`);
    console.log(
      pix.ok
        ? `  ${pix.body.name} | owner business: ${pix.body.owner_business?.name} (${pix.body.owner_business?.id}) | lastFired ${pix.body.last_fired_time || 'never'}`
        : `  error: ${JSON.stringify(pix.body.error)}`
    );
  }

  if (acct) {
    const a = await graph(acct, {
      fields: 'name,account_status,business{id,name},currency',
      access_token: token,
    });
    console.log(`\n=== Ad account ${acct} ===`);
    console.log(
      a.ok
        ? `  ${a.body.name} | business: ${a.body.business?.name || '(personal / no business)'} (${a.body.business?.id || '-'}) | status ${a.body.account_status}`
        : `  error: ${JSON.stringify(a.body.error)}`
    );
  }

  const biz = await graph('me/businesses', { fields: 'id,name', access_token: token });
  for (const b of biz.body?.data || []) {
    console.log(`\n=== Business: ${b.name} (${b.id}) ===`);

    const pixels = await graph(`${b.id}/owned_pixels`, {
      fields: 'id,name,last_fired_time',
      access_token: token,
    });
    console.log('  Pixels / datasets:');
    if (pixels.ok && (pixels.body.data || []).length) {
      pixels.body.data.forEach((p) =>
        console.log(
          `    ${p.id}  ${p.name}  lastFired=${p.last_fired_time || 'never'}${p.id === pixelId ? '   <-- WE SEND HERE' : ''}`
        )
      );
    } else {
      console.log(`    ${pixels.ok ? '(none)' : 'error: ' + JSON.stringify(pixels.body.error)}`);
    }

    const accounts = await graph(`${b.id}/owned_ad_accounts`, {
      fields: 'id,name,account_status',
      access_token: token,
    });
    console.log('  Ad accounts:');
    if (accounts.ok && (accounts.body.data || []).length) {
      accounts.body.data.forEach((a) =>
        console.log(`    ${a.id}  ${a.name}${a.id === acct ? '   <-- CONFIGURED' : ''}`)
      );
    } else {
      console.log(`    ${accounts.ok ? '(none)' : 'error: ' + JSON.stringify(accounts.body.error)}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
