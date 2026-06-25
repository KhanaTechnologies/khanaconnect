const Redis = require('ioredis');

const sharedOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

function buildRedisClient() {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    const useTls =
      redisUrl.startsWith('rediss://') ||
      process.env.REDIS_TLS === 'true' ||
      process.env.REDIS_TLS === '1';

    return new Redis(redisUrl, {
      ...sharedOptions,
      ...(useTls && !redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
    });
  }

  const tls = process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1';

  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    ...(tls ? { tls: {} } : {}),
    ...sharedOptions,
  });
}

const redis = buildRedisClient();

let evictionWarningLogged = false;

redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
  console.error('❌ Redis connection error:', err.message || err);
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
