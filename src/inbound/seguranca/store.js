import Redis from 'ioredis';
import { logger } from '../../logger.js';

/**
 * Contadores e bloqueios de segurança (falhas de login, banimentos).
 * Usa o Redis da stack (REDIS_URL) para valer entre réplicas e sobreviver a
 * restart; sem Redis — ou com ele fora do ar — cai para memória do processo.
 */

const PREFIX = 'sec:';
const memoria = new Map();
let redis = null;
let avisouFalha = false;

function getRedis() {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (!redis) {
    redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
    redis.on('error', () => {});
  }
  return redis;
}

async function comRedis(fn, fallback) {
  const client = getRedis();
  if (client) {
    try {
      if (client.status === 'wait') await client.connect().catch(() => {});
      if (client.status === 'ready') return await fn(client);
    } catch (error) {
      if (!avisouFalha) {
        avisouFalha = true;
        logger.warn('[seguranca] Redis indisponível — usando memória', { message: error.message });
      }
    }
  }
  return fallback();
}

function memoriaGet(key) {
  const item = memoria.get(key);
  if (!item) return null;
  if (item.expira <= Date.now()) {
    memoria.delete(key);
    return null;
  }
  return item;
}

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of memoria) if (v.expira <= agora) memoria.delete(k);
}, 60_000).unref();

/** Incrementa e devolve o total; a janela começa no primeiro incremento. */
export function incrementar(key, ttlSec, quanto = 1) {
  const k = PREFIX + key;
  return comRedis(
    async (client) => {
      const total = await client.incrby(k, quanto);
      if (total === quanto) await client.expire(k, ttlSec);
      return total;
    },
    () => {
      const atual = memoriaGet(k);
      const total = (atual?.valor ?? 0) + quanto;
      memoria.set(k, { valor: total, expira: atual?.expira ?? Date.now() + ttlSec * 1000 });
      return total;
    },
  );
}

/** Grava valor com expiração. */
export function definir(key, valor, ttlSec) {
  const k = PREFIX + key;
  return comRedis(
    (client) => client.set(k, String(valor), 'EX', ttlSec),
    () => memoria.set(k, { valor: String(valor), expira: Date.now() + ttlSec * 1000 }),
  );
}

/** Segundos restantes de uma chave (0 se não existe). */
export function segundosRestantes(key) {
  const k = PREFIX + key;
  return comRedis(
    async (client) => Math.max(0, await client.ttl(k)),
    () => {
      const item = memoriaGet(k);
      return item ? Math.ceil((item.expira - Date.now()) / 1000) : 0;
    },
  );
}

export function obter(key) {
  const k = PREFIX + key;
  return comRedis(
    (client) => client.get(k),
    () => memoriaGet(k)?.valor ?? null,
  );
}

export function remover(...keys) {
  const ks = keys.map((k) => PREFIX + k);
  return comRedis(
    (client) => client.del(...ks),
    () => ks.forEach((k) => memoria.delete(k)),
  );
}
