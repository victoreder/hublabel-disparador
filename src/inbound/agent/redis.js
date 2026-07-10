import Redis from 'ioredis';

let client = null;
const memoryActionLocks = new Map();

function getRedis(redisUrl) {
  if (!redisUrl) return null;
  if (!client) {
    client = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  }
  return client;
}

/**
 * Lock atômico para ações 1x (notificar-humano, transferências).
 * Redis SET NX entre réplicas; fallback em memória no mesmo processo.
 * @returns {Promise<boolean>} true se adquiriu (pode executar)
 */
export async function tryAcquireActionLock(redisUrl, conversaId, tipo, ttlSec = 20) {
  const key = `agent:acao-lock:${conversaId || 'x'}:${tipo || 'x'}`;
  const redis = getRedis(redisUrl);
  if (redis) {
    try {
      const ok = await redis.set(key, '1', 'EX', ttlSec, 'NX');
      return ok === 'OK';
    } catch {
      // cai no fallback em memória
    }
  }

  const now = Date.now();
  const prev = memoryActionLocks.get(key);
  if (prev && now - prev < ttlSec * 1000) return false;
  memoryActionLocks.set(key, now);
  if (memoryActionLocks.size > 500) {
    for (const [k, ts] of memoryActionLocks) {
      if (now - ts > ttlSec * 1000) memoryActionLocks.delete(k);
    }
  }
  return true;
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
