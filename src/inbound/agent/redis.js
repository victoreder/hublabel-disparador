import Redis from 'ioredis';

let client = null;

function getRedis(redisUrl) {
  if (!redisUrl) return null;
  if (!client) {
    client = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  }
  return client;
}

export async function pushGroupingMessage(redisUrl, remoteJid, text) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid || !text?.trim()) return;
  await redis.rpush(remoteJid, text.trim());
}

export async function readGroupingText(redisUrl, remoteJid, limit = 300) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid) return '';
  const items = await redis.lrange(remoteJid, -limit, -1);
  return items.filter(Boolean).join(' ');
}

export async function clearGroupingKey(redisUrl, remoteJid) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid) return;
  await redis.del(remoteJid);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Agrupa mensagens rápidas do mesmo contato (espelha MEMORIA1/2 + Filter do n8n).
 * Retorna null se outra mensagem chegou durante o intervalo.
 */
export async function waitForGroupedText(redisUrl, remoteJid, intervalSeconds) {
  const before = await readGroupingText(redisUrl, remoteJid);
  const waitMs = Math.max(1, Number(intervalSeconds) || 3) * 1000;
  await sleep(waitMs);
  const after = await readGroupingText(redisUrl, remoteJid);
  if (before !== after) return null;
  return after;
}
