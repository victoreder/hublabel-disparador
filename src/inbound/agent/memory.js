import { supabase } from '../../supabase.js';
import { stripActionMarkers } from './parseActions.js';
import {
  getChatHistoryCache,
  setChatHistoryCache,
  touchChatHistoryCache,
  invalidateChatHistoryCache,
} from './redis.js';

/** Cap duro de mensagens no prompt (protege egress + tokens). */
export const HISTORY_MAX_LIMIT = 40;
/** Truncamento por mensagem no contexto do LLM (não afeta SAAS_Mensagens). */
export const HISTORY_MSG_MAX_CHARS = 2000;
/** TTL do cache Redis; renovado a cada leitura. */
export const HISTORY_CACHE_TTL_SEC = 48 * 60 * 60;

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.trunc(n), HISTORY_MAX_LIMIT);
}

function truncateForLlm(text) {
  const s = String(text || '');
  if (s.length <= HISTORY_MSG_MAX_CHARS) return s;
  return `${s.slice(0, HISTORY_MSG_MAX_CHARS)}…`;
}

function rowToCachedMessage(row) {
  const content = truncateForLlm(stripActionMarkers(row?.mensagem));
  if (!content?.trim() || row?.id == null) return null;
  return {
    id: Number(row.id),
    role: row.fromMe ? 'assistant' : 'user',
    content,
  };
}

function toLlmMessages(cached) {
  return (cached ?? [])
    .filter((m) => m?.content?.trim())
    .map(({ role, content }) => ({ role, content }));
}

function trimCached(messages, keep) {
  if (!messages?.length) return [];
  if (messages.length <= keep) return messages;
  return messages.slice(messages.length - keep);
}

async function fetchLatestFromDb(conversaId, limit) {
  const { data, error } = await supabase
    .from('SAAS_Mensagens')
    .select('id, mensagem, fromMe')
    .eq('conversaId', conversaId)
    .eq('apagada', false)
    .order('id', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Erro ao carregar histórico: ${error.message}`);

  return (data ?? [])
    .reverse()
    .map(rowToCachedMessage)
    .filter(Boolean);
}

async function fetchNewerFromDb(conversaId, afterId, maxRows = 100) {
  const { data, error } = await supabase
    .from('SAAS_Mensagens')
    .select('id, mensagem, fromMe')
    .eq('conversaId', conversaId)
    .eq('apagada', false)
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(maxRows);

  if (error) throw new Error(`Erro ao carregar histórico incremental: ${error.message}`);

  return (data ?? []).map(rowToCachedMessage).filter(Boolean);
}

/**
 * Histórico para o LLM: Redis (janela quente) + Postgres no miss
 * ou só mensagens com id > lastId (egress mínimo, cache sempre coerente).
 */
export async function loadChatHistory(
  conversaId,
  limit = 20,
  redisUrl = null,
  ttlSec = HISTORY_CACHE_TTL_SEC,
) {
  const safeLimit = clampLimit(limit);
  if (!conversaId || !safeLimit) return [];

  const url = redisUrl || process.env.REDIS_URL?.trim() || null;
  const ttl = Math.max(60, Number(ttlSec) || HISTORY_CACHE_TTL_SEC);
  const cacheKeep = HISTORY_MAX_LIMIT;

  const cached = await getChatHistoryCache(url, conversaId);
  if (cached?.messages?.length && Number.isFinite(Number(cached.lastId))) {
    const newer = await fetchNewerFromDb(conversaId, Number(cached.lastId));
    let messages = cached.messages;

    if (newer.length) {
      const seen = new Set(messages.map((m) => m.id));
      for (const m of newer) {
        if (!seen.has(m.id)) {
          messages.push(m);
          seen.add(m.id);
        }
      }
      messages = trimCached(messages, cacheKeep);
      const lastId = messages[messages.length - 1]?.id ?? Number(cached.lastId);
      await setChatHistoryCache(url, conversaId, { lastId, messages }, ttl);
    } else {
      await touchChatHistoryCache(url, conversaId, ttl);
    }

    return toLlmMessages(trimCached(messages, safeLimit));
  }

  const messages = await fetchLatestFromDb(conversaId, safeLimit);
  if (messages.length) {
    const lastId = messages[messages.length - 1].id;
    await setChatHistoryCache(
      url,
      conversaId,
      { lastId, messages: trimCached(messages, cacheKeep) },
      ttl,
    );
  }

  return toLlmMessages(messages);
}

/** Invalida cache (soft-delete, correção manual, etc.). */
export async function invalidateChatHistory(conversaId, redisUrl = null) {
  const url = redisUrl || process.env.REDIS_URL?.trim() || null;
  await invalidateChatHistoryCache(url, conversaId);
}
