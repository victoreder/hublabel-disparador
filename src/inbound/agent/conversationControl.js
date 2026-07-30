import { logger } from '../../logger.js';
import Redis from 'ioredis';

let redisClient = null;
const debounceTimers = new Map();
const localActive = new Map();

function getRedis(redisUrl) {
  if (!redisUrl) return null;
  if (!redisClient) {
    redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  }
  return redisClient;
}

export function conversationKey(job) {
  if (job?.conversaId != null) return `c:${job.conversaId}`;
  return `t:${job?.conexaoId || 'x'}:${String(job?.telefone || '').trim()}`;
}

function groupKey(key) {
  return `agent:ctrl:${key}:group`;
}
function pendingKey(key) {
  return `agent:ctrl:${key}:pending`;
}
function procKey(key) {
  return `agent:ctrl:${key}:proc`;
}

async function listPush(redis, key, text, ttlSec = 600) {
  const value = String(text || '').trim();
  if (!value) return;

  if (redis) {
    await redis.rpush(key, value);
    await redis.expire(key, Math.max(60, ttlSec));
    return;
  }

  const memKey = `mem:${key}`;
  if (!localActive.has(memKey)) localActive.set(memKey, { list: [] });
  const bucket = localActive.get(memKey);
  if (!Array.isArray(bucket.list)) bucket.list = [];
  bucket.list.push(value);
}

async function listClaim(redis, key) {
  if (redis) {
    const items = await redis.lrange(key, 0, -1);
    if (!items.length) return [];
    await redis.del(key);
    return items.filter(Boolean);
  }
  const memKey = `mem:${key}`;
  const bucket = localActive.get(memKey);
  const items = Array.isArray(bucket?.list) ? bucket.list.slice() : [];
  if (bucket) bucket.list = [];
  return items.filter(Boolean);
}

function joinMessages(items) {
  return items.filter(Boolean).join('\n');
}

export function clearDebounceTimer(key) {
  const t = debounceTimers.get(key);
  if (t) {
    clearTimeout(t);
    debounceTimers.delete(key);
  }
}

function scheduleDebounce(key, intervalSec, fn) {
  clearDebounceTimer(key);
  const waitMs = Math.max(1, Math.round((Number(intervalSec) || 3) * 1000));
  logger.info('ConvControl: timer agrupamento (re)iniciado', { key, intervalSec, waitMs });
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    Promise.resolve()
      .then(fn)
      .catch((error) => {
        logger.error('ConvControl: falha após agrupamento', {
          key,
          message: error?.message || String(error),
        });
      });
  }, waitMs);
  debounceTimers.set(key, timer);
}

function getLocalProcessing(key) {
  const state = localActive.get(key);
  if (!state?.generationId || state.status !== 'running') return null;
  return state;
}

async function getRedisProcessing(redis, key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(procKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.generationId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function setProcessing(redis, key, state, ttlSec = 600) {
  localActive.set(key, { ...state, status: 'running', hasStartedSending: false });
  if (!redis) return;
  await redis.set(
    procKey(key),
    JSON.stringify({
      generationId: state.generationId,
      startedAt: state.startedAt,
      inputText: state.inputText,
    }),
    'EX',
    ttlSec,
  );
}

async function clearProcessing(redis, key, generationId) {
  const local = localActive.get(key);
  if (local?.generationId === generationId) {
    localActive.delete(key);
  }
  if (!redis) return;
  try {
    const raw = await redis.get(procKey(key));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.generationId === generationId) {
      await redis.del(procKey(key));
    }
  } catch {
    // ignore
  }
}

function abortLocal(key, reason) {
  const local = localActive.get(key);
  if (!local?.abortController) return false;
  if (!local.abortController.signal.aborted) {
    local.abortController.abort(reason || 'cancelled');
  }
  return true;
}

function markSending(key) {
  const local = localActive.get(key);
  if (local) local.hasStartedSending = true;
}

function isAgrupar(agente) {
  return (
    agente?.agruparMensagens === true ||
    agente?.agruparMensagens === 'true' ||
    agente?.agruparMensagens === 1
  );
}

/**
 * Entrada principal do controle por conversa.
 */
export async function handleConversationTurn({
  job,
  agente,
  agentConfig,
  text,
  runGeneration,
  analyzePending,
}) {
  const key = conversationKey(job);
  const redis = getRedis(agentConfig.redisUrl);
  const agrupar = isAgrupar(agente);
  const intervalSec = Number(agente?.intervaloEntreMensagens ?? 3) || 3;
  const ttlSec = Math.max(120, intervalSec * 10);
  const msg = String(text || '').trim();
  if (!msg) return;

  const localProc = getLocalProcessing(key);
  const redisProc = localProc ? null : await getRedisProcessing(redis, key);
  const active = localProc || redisProc;

  if (active?.generationId) {
    const age = Date.now() - Number(active.startedAt || 0);
    const canAbort =
      Boolean(localProc?.abortController) && localProc.hasStartedSending !== true;

    if (canAbort) {
      logger.info('ConvControl: msg antes do envio — abortando LLM e reagrupando', {
        key,
        conversaId: job.conversaId,
        ageMs: age,
        generationId: active.generationId,
      });
      await listPush(redis, pendingKey(key), msg, ttlSec);
      abortLocal(key, 'restart-before-send');
      // O runProcessing em andamento captura AbortError, junta input+pendente e regenera.
      return;
    }

    logger.info('ConvControl: mensagem durante envio — pendente', {
      key,
      conversaId: job.conversaId,
      ageMs: age,
      generationId: active.generationId,
    });
    await listPush(redis, pendingKey(key), msg, ttlSec);
    return;
  }

  if (!agrupar) {
    logger.info('ConvControl: sem agrupamento — processando direto', {
      key,
      conversaId: job.conversaId,
    });
    await runProcessing({
      key,
      job,
      agentConfig,
      inputText: msg,
      runGeneration,
      analyzePending,
      ttlSec,
    });
    return;
  }

  if (!agentConfig.redisUrl) {
    logger.warn('ConvControl: agrupamento sem Redis — usando memória local', {
      key,
      conversaId: job.conversaId,
    });
  }

  await listPush(redis, groupKey(key), msg, ttlSec);
  logger.info('ConvControl: mensagem no buffer de agrupamento', {
    key,
    conversaId: job.conversaId,
    intervalSec,
    preview: msg.slice(0, 120),
  });

  scheduleDebounce(key, intervalSec, () =>
    startGroupedProcessing({
      key,
      job,
      agentConfig,
      intervalSec,
      ttlSec,
      runGeneration,
      analyzePending,
    }),
  );
}

async function startGroupedProcessing({
  key,
  job,
  agentConfig,
  intervalSec,
  ttlSec,
  runGeneration,
  analyzePending,
}) {
  const redis = getRedis(agentConfig.redisUrl);
  if (getLocalProcessing(key)) {
    logger.info('ConvControl: debounce ignorado — já há processamento ativo', {
      key,
      conversaId: job.conversaId,
    });
    return;
  }

  const items = await listClaim(redis, groupKey(key));
  const grouped = joinMessages(items);
  if (!grouped) {
    logger.info('ConvControl: buffer de agrupamento vazio ao claim', {
      key,
      conversaId: job.conversaId,
    });
    return;
  }

  logger.info('ConvControl: agrupamento estável — iniciando processamento', {
    key,
    conversaId: job.conversaId,
    intervalSec,
    qtd: items.length,
    preview: grouped.slice(0, 200),
  });

  await runProcessing({
    key,
    job,
    agentConfig,
    inputText: grouped,
    runGeneration,
    analyzePending,
    ttlSec,
  });
}

async function claimPendingText(redis, key) {
  const items = await listClaim(redis, pendingKey(key));
  return joinMessages(items);
}

async function runProcessing({
  key,
  job,
  agentConfig,
  inputText,
  runGeneration,
  analyzePending,
  ttlSec,
}) {
  const redis = getRedis(agentConfig.redisUrl);
  if (getLocalProcessing(key)) {
    logger.warn('ConvControl: tentativa de segundo processamento — enfileirando como pendente', {
      key,
      conversaId: job.conversaId,
    });
    await listPush(redis, pendingKey(key), inputText, ttlSec);
    return;
  }

  const generationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  const startedAt = Date.now();

  await setProcessing(
    redis,
    key,
    { abortController, generationId, startedAt, inputText },
    ttlSec,
  );

  logger.info('ConvControl: processamento iniciado', {
    key,
    conversaId: job.conversaId,
    generationId,
    preview: String(inputText).slice(0, 200),
  });

  let result = null;
  let aborted = false;
  let restartCombined = null;

  try {
    result = await runGeneration(inputText, {
      signal: abortController.signal,
      generationId,
      markSending: () => markSending(key),
      beforeSend: async () => {
        const pendingText = await claimPendingText(redis, key);
        if (!pendingText) return { defer: false };
        logger.info('ConvControl: pendente antes do envio — descartando rascunho', {
          key,
          conversaId: job.conversaId,
          generationId,
          pendingPreview: pendingText.slice(0, 200),
        });
        return { defer: true, pendingText };
      },
    });

    if (result?.deferred && result.pendingText) {
      restartCombined = joinMessages([inputText, result.pendingText]);
      logger.info('ConvControl: regenerando com input + pendente (sem enviar rascunho)', {
        key,
        conversaId: job.conversaId,
        generationId,
        preview: restartCombined.slice(0, 200),
      });
    } else if (abortController.signal.aborted || result?.aborted) {
      aborted = true;
      const pendingText = await claimPendingText(redis, key);
      if (pendingText) {
        restartCombined = joinMessages([inputText, pendingText]);
        logger.info('ConvControl: abort com pendente — regenerando', {
          key,
          conversaId: job.conversaId,
          generationId,
          preview: restartCombined.slice(0, 200),
        });
      } else {
        logger.info('ConvControl: processamento abortado — sem envio', {
          key,
          conversaId: job.conversaId,
          generationId,
        });
      }
    } else {
      logger.info('ConvControl: resposta enviada', {
        key,
        conversaId: job.conversaId,
        generationId,
        preview: String(result?.replyText || '').slice(0, 200),
      });
    }
  } catch (error) {
    if (error?.name === 'AbortError' || abortController.signal.aborted) {
      aborted = true;
      const pendingText = await claimPendingText(redis, key);
      if (pendingText) {
        restartCombined = joinMessages([inputText, pendingText]);
        logger.info('ConvControl: AbortError com pendente — regenerando', {
          key,
          conversaId: job.conversaId,
          generationId,
          preview: restartCombined.slice(0, 200),
        });
      } else {
        logger.info('ConvControl: AbortError', {
          key,
          conversaId: job.conversaId,
          generationId,
          message: error?.message,
        });
      }
    } else {
      throw error;
    }
  } finally {
    await clearProcessing(redis, key, generationId);
    logger.info('ConvControl: processamento finalizado (lock liberado)', {
      key,
      conversaId: job.conversaId,
      generationId,
    });
  }

  // NÃO dar return no try — senão a regeneração abaixo nunca roda.
  if (restartCombined) {
    logger.info('ConvControl: iniciando regeneração imediata', {
      key,
      conversaId: job.conversaId,
      preview: restartCombined.slice(0, 200),
    });
    await runProcessing({
      key,
      job,
      agentConfig,
      inputText: restartCombined,
      runGeneration,
      analyzePending,
      ttlSec,
    });
    return;
  }

  if (!aborted && result && !result.deferred) {
    await processPendingsAfterReply({
      key,
      job,
      agentConfig,
      inputText: result?.inputText || inputText,
      replyText: result?.replyText || '',
      runGeneration,
      analyzePending,
      ttlSec,
    });
  }
}

async function processPendingsAfterReply({
  key,
  job,
  agentConfig,
  inputText,
  replyText,
  runGeneration,
  analyzePending,
  ttlSec,
}) {
  const redis = getRedis(agentConfig.redisUrl);
  const pendingItems = await listClaim(redis, pendingKey(key));
  if (!pendingItems.length) {
    logger.info('ConvControl: sem mensagens pendentes', {
      key,
      conversaId: job.conversaId,
    });
    return;
  }

  const pendingText = joinMessages(pendingItems);
  logger.info('ConvControl: analisando mensagens pendentes', {
    key,
    conversaId: job.conversaId,
    qtd: pendingItems.length,
    preview: pendingText.slice(0, 200),
  });

  let alreadyAnswered = false;
  try {
    alreadyAnswered = await analyzePending({
      inputText,
      replyText,
      pendingText,
      job,
      agentConfig,
    });
  } catch (error) {
    logger.warn('ConvControl: falha na análise de pendente — vai processar', {
      key,
      conversaId: job.conversaId,
      message: error.message,
    });
    alreadyAnswered = false;
  }

  if (alreadyAnswered) {
    logger.info('ConvControl: pendente já respondida — descartando', {
      key,
      conversaId: job.conversaId,
    });
    return;
  }

  logger.info('ConvControl: pendente precisa de resposta — reprocessando agora', {
    key,
    conversaId: job.conversaId,
  });

  await runProcessing({
    key,
    job,
    agentConfig,
    inputText: pendingText,
    runGeneration,
    analyzePending,
    ttlSec,
  });
}
