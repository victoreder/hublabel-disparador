import { logger } from '../../logger.js';
import { fetchAgente } from '../../supabase.js';
import { executeAgentAction, normalizeTipo } from './actions.js';
import { getAgentConfig } from './config.js';
import { loadChatHistory } from './memory.js';
import { notifyOpenAiSemSaldo } from './notifyHuman.js';
import { runAgentChat } from './openai.js';
import {
  buildArquivoMapFromInstrucoes,
  parseAgentOutputWithActions,
  stripActionMarkers,
} from './parseActions.js';
import {
  classifyChunk,
  extractMediaUrl,
  normalizeMediaUrl,
  splitAgentOutput,
} from './parseResponse.js';
import { buildSystemPrompt } from './prompt.js';
import { preprocessInput } from './preprocess.js';
import { handleConversationTurn } from './conversationControl.js';
import { analyzePendingCovered } from './pendingAnalysis.js';
import { sendAgentChunk, notifyTokenUsage } from './sendReply.js';
import { saveAgentTokenUsage } from './tokens.js';
import { agendarFollowupsAposTurno, cancelarFollowup } from './followup/index.js';

const TOOL_TO_ACAO = {
  NOTIFICAR_HUMANO: 'notificar-humano',
  REQUISICAO_DINAMICA: 'ferramenta-http',
};

/** Ações que só podem rodar 1x por resposta e têm lock curto anti-webhook-duplicado. */
const ONCE_PER_RESPONSE = new Set([
  'notificar-humano',
  'transferir-atendente',
  'transferir-setor',
  'transferir-agente-ia',
]);

/** Evita double-fire entre jobs paralelos (ex.: webhook duplicado). Só para ONCE_PER_RESPONSE. */
const recentActionLocks = new Map();
const ACTION_LOCK_MS = 5_000;

function actionDedupeKey(acao) {
  const tipo = normalizeTipo(acao?.tipo);
  if (ONCE_PER_RESPONSE.has(tipo)) return tipo;

  const dados = acao?.dados ?? {};
  if (tipo === 'adicionar-etiqueta' || tipo === 'remover-etiqueta') {
    return `${tipo}:${dados.etiquetaId ?? ''}`;
  }
  if (tipo === 'campo-personalizado') {
    return `${tipo}:${dados.campoId ?? ''}`;
  }
  if (tipo === 'enviar-midia') {
    return `${tipo}:${dados.arquivoId || dados.url || ''}`;
  }
  if (tipo === 'crm' || tipo === 'crm-mover' || tipo === 'crm-preencher' || tipo === 'crm-criar') {
    return `${tipo}:${dados.modo || ''}:${dados.quadroId || ''}:${dados.etapaId || ''}`;
  }

  return JSON.stringify({ tipo, dados });
}

function isRecentlyExecuted(conversaId, key) {
  const lockKey = `${conversaId || 'x'}:${key}`;
  const now = Date.now();
  const prev = recentActionLocks.get(lockKey);
  if (prev && now - prev < ACTION_LOCK_MS) return true;
  recentActionLocks.set(lockKey, now);
  if (recentActionLocks.size > 500) {
    for (const [k, ts] of recentActionLocks) {
      if (now - ts > ACTION_LOCK_MS) recentActionLocks.delete(k);
    }
  }
  return false;
}

function prepareSegments(segments, toolsExecuted = [], conversaId = null) {
  const skipTipos = new Set(
    (toolsExecuted || [])
      .map((name) => TOOL_TO_ACAO[name])
      .filter(Boolean),
  );
  const seen = new Set();
  const out = [];

  for (const segment of segments) {
    if (segment.type !== 'action') {
      out.push(segment);
      continue;
    }

    const tipo = normalizeTipo(segment.content?.tipo);
    if (skipTipos.has(tipo)) {
      logger.info('Ação ignorada — já executada via tool OpenAI', { tipo, conversaId });
      continue;
    }

    const key = actionDedupeKey({ ...segment.content, tipo });
    if (seen.has(key)) {
      logger.info('Ação duplicada ignorada (mesma resposta)', { tipo, key, conversaId });
      continue;
    }
    seen.add(key);

    // Lock cross-job só para notify/transfer (anti webhook duplo).
    // CRM, etiqueta, campo, mídia podem repetir em turnos seguintes na mesma conversa.
    if (ONCE_PER_RESPONSE.has(tipo) && isRecentlyExecuted(conversaId, key)) {
      logger.info('Ação duplicada ignorada (janela recente)', { tipo, key, conversaId });
      continue;
    }

    out.push({ ...segment, content: { ...segment.content, tipo } });
  }

  return out;
}

/**
 * Remove frases que só relatam status interno da ação.
 * Mantém o restante da mensagem conversacional (ex.: "Deseja mais alguma coisa?").
 * Não apaga linhas inteiras só por mencionar "transfer" — isso silenciava o usuário
 * quando a ação falhava (ex.: setorId ausente) e o modelo narrava a transferência.
 */
function scrubActionNarration(text) {
  let t = String(text || '');

  const linePatterns = [
    /^[^\n]*etiqueta[^\n]*(adicionad|removid|aplicad)[^\n]*$/gim,
    /^humano notificado[^\n]*$/gim,
    /^notificaç(ão|ões) enviada[^\n]*$/gim,
    /^transferido para (o )?setor[^\n]*$/gim,
    /^transferido para (um )?atendente[^\n]*$/gim,
    /^campo[^\n]*(salv|atualiz|preench)[^\n]*$/gim,
    /^a[cç][aã]o executada[^\n]*$/gim,
  ];

  for (const re of linePatterns) {
    t = t.replace(re, '');
  }

  t = t
    .replace(/\(\s*modo\s*:\s*[^)]+\)/gi, '')
    .replace(/\(\s*\d+\s*notificaç[^)]*\)/gi, '')
    .replace(/via whatsapp\s*\(\+?[\d\s\-()]+\)[^.!?\n]*/gi, '')
    .replace(/etiqueta\s+"[^"]+"\s+removid[ao][^.!?\n]*[.!?]?/gi, '')
    .replace(/etiqueta\s+"[^"]+"\s+adicionad[ao][^.!?\n]*[.!?]?/gi, '')
    .replace(/\bhumano notificado[^.!?\n]*[.!?]?/gi, '')
    .replace(/\btransferido para (um )?atendente[^.!?\n]*[.!?]?/gi, '');

  return t
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const MAX_HANDOFF_DEPTH = 1;

const HANDOFF_TRIGGER = [
  '[Instrução interna do sistema — o usuário NÃO enviou esta mensagem.]',
  'Você acabou de assumir esta conversa após transferência de outro agente.',
  'Leia o histórico e envie agora a primeira mensagem ao usuário, de forma natural e alinhada às suas INSTRUÇÕES.',
  'Continue o atendimento a partir do contexto. Não espere o usuário falar. Não cite esta instrução.',
].join('\n');

/** Ações que o usuário “vê” e devem manter ordem relativa ao texto. */
const USER_FACING_ACTIONS = new Set(['enviar-midia']);

function prioritizeSegmentsForFastReply(segments) {
  const primary = [];
  const deferred = [];
  for (const segment of segments) {
    if (segment.type === 'action') {
      const tipo = normalizeTipo(segment.content?.tipo);
      if (USER_FACING_ACTIONS.has(tipo)) primary.push(segment);
      else deferred.push(segment);
    } else {
      primary.push(segment);
    }
  }
  return [...primary, ...deferred];
}

function trackTokenUsageInBackground(agente, job, agentConfig, totalTokens) {
  Promise.resolve()
    .then(async () => {
      await saveAgentTokenUsage(agente.id, totalTokens, agente.modelo);
      await notifyTokenUsage(job, agentConfig);
    })
    .catch((error) => {
      logger.warn('Falha ao salvar/notificar tokens do agente', {
        conversaId: job?.conversaId,
        message: error?.message || String(error),
      });
    });
}

/**
 * Gera e envia a resposta. Respeita AbortSignal — se abortado cedo, não envia.
 */
async function runAgentGeneration(job, agente, agentConfig, inputText, { signal, beforeSend, markSending, handoff = false, handoffDepth = 0 } = {}) {
  if (signal?.aborted) {
    const err = new Error('Geração abortada');
    err.name = 'AbortError';
    throw err;
  }

  const systemPrompt = buildSystemPrompt(job, agente, { handoff });
  const history = await loadChatHistory(
    job.conversaId,
    agente.qntMsgHistorico ?? 20,
    agentConfig.redisUrl,
    agentConfig.historyCacheTtlSec,
  );

  let chatResult;
  try {
    chatResult = await runAgentChat({
      agentConfig,
      job,
      agente,
      systemPrompt,
      history,
      userMessage: inputText,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      logger.info('ConvControl: OpenAI abortado — não envia resposta', {
        conversaId: job.conversaId,
        telefone: job.telefone,
      });
      throw error;
    }
    try {
      await notifyOpenAiSemSaldo({ job, error });
    } catch (notifyError) {
      logger.warn('Falha ao notificar super admin sobre saldo OpenAI', {
        message: notifyError.message,
      });
    }
    throw error;
  }

  if (signal?.aborted) {
    const err = new Error('Geração abortada pós-OpenAI');
    err.name = 'AbortError';
    throw err;
  }

  const output = typeof chatResult === 'string' ? chatResult : chatResult?.content;
  const toolsExecuted = typeof chatResult === 'string' ? [] : chatResult?.toolsExecuted ?? [];
  const chatTokens = typeof chatResult === 'string' ? 0 : Number(chatResult?.totalTokens ?? 0);

  if (!output) {
    logger.warn('Agente IA sem resposta', { conversaId: job.conversaId });
    return { replyText: '', inputText, aborted: false };
  }

  const rawSegments = parseAgentOutputWithActions(output);
  const segments = prioritizeSegmentsForFastReply(
    prepareSegments(rawSegments, toolsExecuted, job.conversaId),
  );
  const acoesNoOutput = rawSegments.filter((s) => s.type === 'action').map((s) => s.content?.tipo);
  const acoesAposDedupe = segments.filter((s) => s.type === 'action').map((s) => s.content?.tipo);

  logger.info('Agente: segmentos parseados', {
    conversaId: job.conversaId,
    acoesRaw: acoesNoOutput,
    acoes: acoesAposDedupe,
    textos: segments.filter((s) => s.type === 'text').length,
    toolsExecuted,
  });

  if (!acoesNoOutput.length) {
    logger.info('Agente respondeu sem [[acao:]]', {
      conversaId: job.conversaId,
      preview: String(output).slice(0, 280),
    });
  }

  const arquivoMap = buildArquivoMapFromInstrucoes(agente.instrucoes);
  const urlsMidiaInstrucao = new Set(
    [...arquivoMap.values()]
      .map((v) => normalizeMediaUrl(v?.url))
      .filter(Boolean),
  );
  const temAcaoEnviarMidia = segments.some(
    (s) => s.type === 'action' && normalizeTipo(s.content?.tipo) === 'enviar-midia',
  );

  // Se chegou mensagem durante o LLM, descarta o rascunho e regenera com tudo junto.
  if (typeof beforeSend === 'function') {
    const gate = await beforeSend();
    if (gate?.defer) {
      if (chatTokens > 0) {
        trackTokenUsageInBackground(agente, job, agentConfig, chatTokens);
      }
      logger.info('ConvControl: rascunho descartado (pendente antes do envio)', {
        conversaId: job.conversaId,
        telefone: job.telefone,
        pendingPreview: String(gate.pendingText || '').slice(0, 200),
      });
      return {
        deferred: true,
        pendingText: gate.pendingText,
        inputText,
        replyText: '',
        aborted: false,
      };
    }
  }

  if (typeof markSending === 'function') {
    markSending();
  }

  const midiasEnviadas = new Set();
  const actionCtx = {
    job,
    agente,
    agentConfig,
    arquivoMap,
    midiasEnviadas,
    history,
    userMessage: inputText,
    respostaAgente: stripActionMarkers(output),
    textoContexto: inputText,
  };

  let chunksEnviados = 0;
  let acoesExecutadas = 0;
  let tokensExtras = 0;
  let transferredToAgenteId = null;
  const sentParts = [];

  for (const segment of segments) {
    if (signal?.aborted) {
      logger.info('ConvControl: envio interrompido por abort', {
        conversaId: job.conversaId,
        telefone: job.telefone,
      });
      const err = new Error('Geração abortada durante envio');
      err.name = 'AbortError';
      throw err;
    }

    if (segment.type === 'action') {
      try {
        const resultado = await executeAgentAction(segment.content, actionCtx);
        if (resultado?.skipped) {
          logger.info('Ação duplicada não contada', {
            conversaId: job.conversaId,
            tipo: segment.content?.tipo,
            reason: resultado.reason,
          });
          continue;
        }
        acoesExecutadas += 1;
        tokensExtras += Number(resultado?.tokensExtras ?? 0) || 0;
        if (resultado?.blocked) {
          logger.warn('Ação bloqueada (sem [[acao:]] nas instruções)', {
            conversaId: job.conversaId,
            tipo: segment.content?.tipo,
          });
        } else if (resultado?.success === false) {
          logger.warn('Ação retornou success:false', {
            conversaId: job.conversaId,
            tipo: segment.content?.tipo,
            error: resultado.error,
            dados: segment.content?.dados ?? null,
          });
        } else {
          logger.info('Ação OK', {
            conversaId: job.conversaId,
            tipo: segment.content?.tipo,
          });
          if (normalizeTipo(segment.content?.tipo) === 'enviar-midia') {
            const d = segment.content?.dados || {};
            sentParts.push(`[midia:${d.arquivoId || d.url || ''}]`);
          }
          if (
            normalizeTipo(segment.content?.tipo) === 'transferir-agente-ia' &&
            resultado?.agenteId &&
            Number(resultado.agenteId) !== Number(agente.id)
          ) {
            transferredToAgenteId = Number(resultado.agenteId);
          }
        }
      } catch (error) {
        logger.warn('Falha ao executar ação do agente — ignorado', {
          conversaId: job.conversaId,
          tipo: segment.content?.tipo,
          message: error.message,
        });
      }
      continue;
    }

    const textoLimpo = scrubActionNarration(stripActionMarkers(segment.content));
    if (!textoLimpo) continue;

    const chunks = splitAgentOutput(textoLimpo, agente.separarMensagens !== false);
    for (const chunk of chunks) {
      if (signal?.aborted) {
        const err = new Error('Geração abortada durante envio de chunk');
        err.name = 'AbortError';
        throw err;
      }

      const textoChunk = scrubActionNarration(stripActionMarkers(chunk.text));
      if (!textoChunk) continue;

      const kind = chunk.kind || classifyChunk(textoChunk);
      const mediaUrl = normalizeMediaUrl(extractMediaUrl(textoChunk));

      if (
        temAcaoEnviarMidia &&
        kind !== 'text' &&
        mediaUrl &&
        urlsMidiaInstrucao.has(mediaUrl)
      ) {
        logger.info('Midia markdown ignorada (já coberta por [[acao:enviar-midia]])', {
          conversaId: job.conversaId,
          kind,
          url: mediaUrl,
        });
        continue;
      }

      if (kind !== 'text' && mediaUrl) {
        if (midiasEnviadas.has(mediaUrl)) {
          logger.info('Midia duplicada ignorada (já enviada nesta resposta)', {
            conversaId: job.conversaId,
            kind,
            url: mediaUrl,
          });
          continue;
        }
        midiasEnviadas.add(mediaUrl);
      }

      try {
        const sent = await sendAgentChunk(job, { ...chunk, kind, text: textoChunk }, agentConfig);
        if (sent?.skipped) continue;
        chunksEnviados += 1;
        sentParts.push(textoChunk.slice(0, 500));
      } catch (error) {
        logger.error('Falha ao enviar resposta do agente', {
          conversaId: job.conversaId,
          kind,
          message: error.message,
        });
      }
    }
  }

  const totalTokens = chatTokens + tokensExtras;
  trackTokenUsageInBackground(agente, job, agentConfig, totalTokens);

  logger.info('Agente IA processado', {
    canal: job.canal,
    conversaId: job.conversaId,
    chunks: chunksEnviados,
    acoes: acoesExecutadas,
    toolsExecuted,
    totalTokens,
    tokensExtras,
    handoff,
  });

  const result = {
    replyText: sentParts.join('\n').trim() || stripActionMarkers(output),
    inputText,
    aborted: false,
  };

  if (transferredToAgenteId && handoffDepth < MAX_HANDOFF_DEPTH) {
    const handoffResult = await runTransferredAgentGreeting({
      job,
      agentConfig,
      fromAgenteId: agente.id,
      toAgenteId: transferredToAgenteId,
      signal,
      markSending,
      handoffDepth,
    });
    if (handoffResult?.replyText) {
      result.replyText = [result.replyText, handoffResult.replyText].filter(Boolean).join('\n').trim();
    }
  }

  return result;
}

async function runTransferredAgentGreeting({
  job,
  agentConfig,
  fromAgenteId,
  toAgenteId,
  signal,
  markSending,
  handoffDepth,
}) {
  let novoAgente;
  try {
    novoAgente = await fetchAgente(toAgenteId);
  } catch (error) {
    logger.warn('Handoff: falha ao carregar novo agente', {
      conversaId: job.conversaId,
      toAgenteId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!novoAgente) {
    logger.warn('Handoff: novo agente não encontrado', {
      conversaId: job.conversaId,
      toAgenteId,
    });
    return null;
  }

  if (novoAgente.ativo === false) {
    logger.info('Handoff: novo agente inativo — sem mensagem ativa', {
      conversaId: job.conversaId,
      toAgenteId,
    });
    return null;
  }

  job.agente = novoAgente;
  job.agenteId = novoAgente.id;

  logger.info('Handoff: novo agente enviará a primeira mensagem', {
    conversaId: job.conversaId,
    de: fromAgenteId,
    para: novoAgente.id,
  });

  return runAgentGeneration(job, novoAgente, agentConfig, HANDOFF_TRIGGER, {
    signal,
    markSending,
    handoff: true,
    handoffDepth: handoffDepth + 1,
  });
}

export async function processAgentJob(job) {
  const [agentConfig, agenteLoaded] = await Promise.all([
    getAgentConfig(),
    job.agente ? Promise.resolve(job.agente) : job.agenteId ? fetchAgente(job.agenteId) : Promise.resolve(null),
  ]);
  const agente = job.agente ?? agenteLoaded;

  if (!agente) {
    logger.warn('Agente IA não encontrado', { agenteId: job.agenteId });
    return;
  }

  if (agente.ativo === false) {
    logger.info('Agente IA inativo', { agenteId: agente.id });
    return;
  }

  job.agente = agente;
  job.agenteId = agente.id;

  await cancelarFollowup(job.conversaId, 'cliente_respondeu').catch(() => {});

  const textoPreprocessado = await preprocessInput(job, agente, agentConfig);
  if (textoPreprocessado == null) return;

  const agrupar =
    agente.agruparMensagens === true ||
    agente.agruparMensagens === 'true' ||
    agente.agruparMensagens === 1;
  const intervaloSec = Number(agente.intervaloEntreMensagens ?? 3) || 3;

  logger.info('ConvControl: job recebido', {
    conversaId: job.conversaId,
    telefone: job.telefone,
    agenteId: agente.id,
    agrupar,
    intervaloSec,
    cancelWindowMs: agentConfig.cancelWindowMs,
    preview: String(textoPreprocessado).slice(0, 120),
  });

  await handleConversationTurn({
    job,
    agente,
    agentConfig,
    text: textoPreprocessado,
    runGeneration: (inputText, ctx) =>
      runAgentGeneration(job, job.agente || agente, agentConfig, inputText, ctx),
    analyzePending: (args) => analyzePendingCovered(args),
    onTurnComplete: () =>
      agendarFollowupsAposTurno(job, job.agente || agente, agentConfig),
  });
}

export function createAgentWorker() {
  return { processAgentJob };
}
