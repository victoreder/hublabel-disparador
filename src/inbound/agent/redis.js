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

function groupingKey(remoteJid) {
  return `agent:group:${String(remoteJid || '').trim()}`;
}

function historyKey(conversaId) {
  return `agent:hist:${conversaId}`;
}

/**
 * Cache do histórico LLM por conversa.
 * Payload: { lastId: number, messages: [{ id, role, content }] }
 */
export async function getChatHistoryCache(redisUrl, conversaId) {
  const redis = getRedis(redisUrl);
  if (!redis || conversaId == null) return null;
  try {
    const raw = await redis.get(historyKey(conversaId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setChatHistoryCache(redisUrl, conversaId, payload, ttlSec = 172800) {
  const redis = getRedis(redisUrl);
  if (!redis || conversaId == null || !payload) return;
  try {
    const ttl = Math.max(60, Number(ttlSec) || 172800);
    await redis.set(historyKey(conversaId), JSON.stringify(payload), 'EX', ttl);
  } catch {
    // cache best-effort
  }
}

export async function touchChatHistoryCache(redisUrl, conversaId, ttlSec = 172800) {
  const redis = getRedis(redisUrl);
  if (!redis || conversaId == null) return;
  try {
    const ttl = Math.max(60, Number(ttlSec) || 172800);
    await redis.expire(historyKey(conversaId), ttl);
  } catch {
    // ignore
  }
}

export async function invalidateChatHistoryCache(redisUrl, conversaId) {
  const redis = getRedis(redisUrl);
  if (!redis || conversaId == null) return;
  try {
    await redis.del(historyKey(conversaId));
  } catch {
    // ignore
  }
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

export async function pushGroupingMessage(redisUrl, remoteJid, text, ttlSec = 300) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid || !text?.trim()) return;
  const key = groupingKey(remoteJid);
  await redis.rpush(key, text.trim());
  await redis.expire(key, Math.max(60, Number(ttlSec) || 300));
}

export async function readGroupingText(redisUrl, remoteJid, limit = 300) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid) return '';
  const items = await redis.lrange(groupingKey(remoteJid), -limit, -1);
  return items.filter(Boolean).join(' ');
}

export async function clearGroupingKey(redisUrl, remoteJid) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid) return;
  await redis.del(groupingKey(remoteJid));
}

/**
 * Claim atômico do buffer estável: só um job “ganha” e processa.
 * Evita double-reply e não apaga mensagens que chegarem durante o LLM.
 */
async function claimGroupingText(redisUrl, remoteJid, expected) {
  const redis = getRedis(redisUrl);
  if (!redis || !remoteJid) return null;

  const key = groupingKey(remoteJid);
  const claimKey = `${key}:claim`;
  const got = await redis.set(claimKey, '1', 'EX', 15, 'NX');
  if (got !== 'OK') return null;

  try {
    const current = await readGroupingText(redisUrl, remoteJid);
    if (!current || current !== expected) return null;
    await redis.del(key);
    return current;
  } finally {
    await redis.del(claimKey).catch(() => {});
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Agrupa mensagens rápidas do mesmo contato (espelha MEMORIA1/2 + Filter do n8n).
 * Retorna null se outra mensagem chegou durante o intervalo, ou se outro job já claimou.
 * Em sucesso, já remove o buffer do Redis (claim) — não limpar de novo no fim do job.
 */
export async function waitForGroupedText(redisUrl, remoteJid, intervalSeconds) {
  const before = await readGroupingText(redisUrl, remoteJid);
  if (!before) return null;

  const waitMs = Math.max(1, Number(intervalSeconds) || 3) * 1000;
  await sleep(waitMs);

  const after = await readGroupingText(redisUrl, remoteJid);
  if (!after || before !== after) return null;

  return claimGroupingText(redisUrl, remoteJid, after);
}
