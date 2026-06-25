const Redis = require('ioredis');

const sharedOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

function parseTlsEnv() {
  const raw = process.env.REDIS_TLS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/** TLS on/off: REDIS_TLS env wins; otherwise infer from rediss:// vs redis://. */
function resolveUseTls(redisUrl) {
  const envTls = parseTlsEnv();
  if (envTls !== null) return envTls;
  return /^rediss:\/\//i.test(String(redisUrl || '').trim());
}

function buildTlsOptions(hostname) {
  return {
    servername: hostname,
    rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
  };
}

function logRedisTarget(host, port, useTls) {
  console.log(`[redis] Connecting to ${host}:${port}${useTls ? ' (TLS)' : ' (plain)'}`);
}

function buildRedisClient() {
  const rawUrl = (process.env.REDIS_URL || '').trim();

  if (rawUrl) {
    const useTls = resolveUseTls(rawUrl);
    const connectUrl = useTls
      ? rawUrl.replace(/^redis:\/\//i, 'rediss://')
      : rawUrl.replace(/^rediss:\/\//i, 'redis://');

    // ioredis + Redis Cloud: redis:// URL with explicit tls block (more reliable than rediss:// alone).
    const ioredisUrl = connectUrl.replace(/^rediss:\/\//i, 'redis://');
    const options = { ...sharedOptions };

    let hostname = 'redis';
    let port = '6379';
    try {
      const parsed = new URL(ioredisUrl);
      hostname = parsed.hostname;
      port = parsed.port || '6379';
    } catch {
      // keep defaults
    }

    logRedisTarget(hostname, port, useTls);

    if (useTls) {
      options.tls = buildTlsOptions(hostname);
    }

    return new Redis(ioredisUrl, options);
  }

  const useTls = parseTlsEnv() === true;
  const host = process.env.REDIS_HOST || 'localhost';
  const port = Number(process.env.REDIS_PORT) || 6379;

  logRedisTarget(host, port, useTls);

  return new Redis({
    host,
    port,
    password: process.env.REDIS_PASSWORD || undefined,
    ...(useTls ? { tls: buildTlsOptions(host) } : {}),
    ...sharedOptions,
  });
}

const redis = buildRedisClient();

let evictionWarningLogged = false;

redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error('❌ Redis connection error:', msg);
  if (msg.includes('wrong version number')) {
    console.error(
      '[redis] TLS mismatch: set REDIS_TLS=false and use a redis:// URL if your provider endpoint is non-TLS, or enable TLS in the Redis dashboard and use rediss:// with REDIS_TLS=true.'
    );
  }
});

redis.on('ready', async () => {
  if (evictionWarningLogged) return;
  try {
    const policy = await redis.config('GET', 'maxmemory-policy');
    const value = Array.isArray(policy) ? policy[1] : '';
    if (value && value !== 'noeviction') {
      evictionWarningLogged = true;
      console.warn(
        `[redis] maxmemory-policy is "${value}". BullMQ recommends "noeviction" so queued jobs are not dropped. Update this in your Redis provider dashboard.`
      );
    }
  } catch {
    // Managed Redis often blocks CONFIG GET — ignore
  }
});

/** BullMQ connection options (shared across queues/workers). */
function getBullMqConnection() {
  return redis;
}

/** Suppress repeated BullMQ eviction policy warnings when the provider cannot be changed. */
const bullMqSettings = {
  skipEvictionPolicyCheck: true,
};

module.exports = redis;
module.exports.getBullMqConnection = getBullMqConnection;
module.exports.bullMqSettings = bullMqSettings;
