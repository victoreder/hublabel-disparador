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
import { splitAgentOutput } from './parseResponse.js';
import { buildSystemPrompt } from './prompt.js';
import { preprocessInput } from './preprocess.js';
import {
  clearGroupingKey,
  pushGroupingMessage,
  waitForGroupedText,
} from './redis.js';
import { sendAgentChunk, notifyTokenUsage } from './sendReply.js';
import { saveAgentTokenUsage } from './tokens.js';

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

export async function processAgentJob(job) {
  const agentConfig = await getAgentConfig();
  const agente = job.agente ?? (job.agenteId ? await fetchAgente(job.agenteId) : null);

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

  const textoPreprocessado = await preprocessInput(job, agente, agentConfig);
  if (textoPreprocessado == null) return;

  let inputText = textoPreprocessado;

  if (agente.agruparMensagens && agentConfig.redisUrl && job.telefone) {
    await pushGroupingMessage(agentConfig.redisUrl, job.telefone, textoPreprocessado);
    const grouped = await waitForGroupedText(
      agentConfig.redisUrl,
      job.telefone,
      agente.intervaloEntreMensagens ?? 3,
    );
    if (!grouped) {
      logger.debug('Mensagem agrupada — aguardando próxima', { telefone: job.telefone });
      return;
    }
    inputText = grouped;
  }

  const systemPrompt = buildSystemPrompt(job, agente);
  const history = await loadChatHistory(job.conversaId, agente.qntMsgHistorico ?? 20);

  let chatResult;
  try {
    chatResult = await runAgentChat({
      agentConfig,
      job,
      agente,
      systemPrompt,
      history,
      userMessage: inputText,
    });
  } catch (error) {
    try {
      await notifyOpenAiSemSaldo({ job, error });
    } catch (notifyError) {
      logger.warn('Falha ao notificar super admin sobre saldo OpenAI', {
        message: notifyError.message,
      });
    }
    throw error;
  }

  const output = typeof chatResult === 'string' ? chatResult : chatResult?.content;
  const toolsExecuted = typeof chatResult === 'string' ? [] : chatResult?.toolsExecuted ?? [];
  const chatTokens = typeof chatResult === 'string' ? 0 : Number(chatResult?.totalTokens ?? 0);

  if (!output) {
    logger.warn('Agente IA sem resposta', { conversaId: job.conversaId });
    return;
  }

  const rawSegments = parseAgentOutputWithActions(output);
  const segments = prepareSegments(rawSegments, toolsExecuted, job.conversaId);
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
  const actionCtx = {
    job,
    agente,
    agentConfig,
    arquivoMap,
    history,
    userMessage: inputText,
    respostaAgente: stripActionMarkers(output),
    textoContexto: inputText,
  };

  let chunksEnviados = 0;
  let acoesExecutadas = 0;
  let tokensExtras = 0;

  for (const segment of segments) {
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
      const textoChunk = scrubActionNarration(stripActionMarkers(chunk.text));
      if (!textoChunk) continue;
      try {
        await sendAgentChunk(job, { ...chunk, text: textoChunk }, agentConfig);
        chunksEnviados += 1;
      } catch (error) {
        logger.error('Falha ao enviar resposta do agente', {
          conversaId: job.conversaId,
          kind: chunk.kind,
          message: error.message,
        });
      }
    }
  }

  if (agentConfig.redisUrl && job.telefone) {
    await clearGroupingKey(agentConfig.redisUrl, job.telefone);
  }

  const totalTokens = chatTokens + tokensExtras;
  await saveAgentTokenUsage(agente.id, totalTokens, agente.modelo);
  await notifyTokenUsage(job, agentConfig);

  logger.info('Agente IA processado', {
    canal: job.canal,
    conversaId: job.conversaId,
    chunks: chunksEnviados,
    acoes: acoesExecutadas,
    toolsExecuted,
    totalTokens,
    tokensExtras,
  });
}

export function createAgentWorker() {
  return { processAgentJob };
}
