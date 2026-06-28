import { logger } from '../../logger.js';
import { fetchAgente, fetchConfigIA, fetchConversaAgente } from '../../supabase.js';
import { executeAgentAction } from './actions.js';
import { getAgentConfig } from './config.js';
import { loadChatHistory } from './memory.js';
import { runAgentChat } from './openai.js';
import { splitAgentOutput } from './parseResponse.js';
import { buildArquivoMapFromInstrucoes, parseAgentOutputWithActions } from './parseActions.js';
import { buildSystemPrompt } from './prompt.js';
import { preprocessInput } from './preprocess.js';
import {
  clearGroupingKey,
  pushGroupingMessage,
  waitForGroupedText,
} from './redis.js';
import { sendAgentChunk } from './sendReply.js';
import { saveAgentTokenUsage } from './tokens.js';

async function resolveAgenteAtivo(job) {
  if (job.conversaId) {
    const conversa = await fetchConversaAgente(job.conversaId);
    job.conversa = conversa;

    const agenteIdConversa = conversa?.idAgente;
    if (agenteIdConversa) {
      const agente = await fetchAgente(agenteIdConversa);
      if (agente) return agente;
    }
  }

  const agenteIdConexao =
    job.conexao?.idAgente ?? job.agenteId ?? job.agente?.id ?? null;

  if (job.agente?.id === agenteIdConexao) return job.agente;
  if (agenteIdConexao) return fetchAgente(agenteIdConexao);
  return job.agente ?? null;
}

export async function processAgentJob(job) {
  logger.info('Agent worker: iniciando', {
    canal: job?.canal,
    conexaoId: job?.conexaoId,
    conversaId: job?.conversaId,
    agenteId: job?.agenteId,
    messageType: job?.messageType,
    telefone: job?.telefone,
  });

  let agentConfig;
  try {
    agentConfig = getAgentConfig(await fetchConfigIA());
  } catch (error) {
    logger.error('Agent worker: falha ao carregar SAAS_Config_IA', { message: error.message });
    throw error;
  }

  const agente = await resolveAgenteAtivo(job);

  if (!agente) {
    logger.warn('Agent worker: agente não encontrado', {
      agenteId: job.agenteId,
      conversaId: job.conversaId,
    });
    return;
  }

  if (agente.ativo === false) {
    logger.info('Agent worker: agente inativo', { agenteId: agente.id, conversaId: job.conversaId });
    return;
  }

  job.agente = agente;
  job.agenteId = agente.id;

  const textoPreprocessado = await preprocessInput(job, agente, agentConfig);
  if (textoPreprocessado == null) {
    logger.info('Agent worker: preprocess abortou (fallback enviado ou mídia ignorada)', {
      conversaId: job.conversaId,
      messageType: job.messageType,
    });
    return;
  }

  let inputText = textoPreprocessado;

  if (agente.agruparMensagens && agentConfig.redisUrl && job.telefone) {
    await pushGroupingMessage(agentConfig.redisUrl, job.telefone, textoPreprocessado);
    const grouped = await waitForGroupedText(
      agentConfig.redisUrl,
      job.telefone,
      agente.intervaloEntreMensagens ?? 3,
    );
    if (!grouped) {
      logger.info('Agent worker: aguardando agrupamento de mensagens', {
        telefone: job.telefone,
        intervaloSeg: agente.intervaloEntreMensagens ?? 3,
      });
      return;
    }
    inputText = grouped;
  }

  const systemPrompt = buildSystemPrompt(job, agente);
  const history = await loadChatHistory(job.conversaId, agente.qntMsgHistorico ?? 20);

  const chatResult = await runAgentChat({
    agentConfig,
    job,
    agente,
    systemPrompt,
    history,
    userMessage: inputText,
  });

  if (!chatResult?.content) {
    logger.warn('Agente IA sem resposta', { conversaId: job.conversaId });
    return;
  }

  const segments = parseAgentOutputWithActions(chatResult.content);
  const arquivoMap = buildArquivoMapFromInstrucoes(agente.instrucoes);
  const actionCtx = {
    job,
    agente,
    agentConfig,
    arquivoMap,
    history,
    userMessage: inputText,
    respostaAgente: chatResult.content,
  };
  const separarMensagens = agente.separarMensagens !== false;

  for (const segment of segments) {
    if (segment.type === 'text') {
      const chunks = splitAgentOutput(segment.content, separarMensagens);
      for (const chunk of chunks) {
        try {
          await sendAgentChunk(job, chunk, agentConfig);
        } catch (error) {
          logger.error('Falha ao enviar resposta do agente', {
            conversaId: job.conversaId,
            kind: chunk.kind,
            message: error.message,
          });
        }
      }
      continue;
    }

    if (segment.type === 'action') {
      const textoAnterior = segments
        .slice(0, segments.indexOf(segment))
        .filter((s) => s.type === 'text')
        .map((s) => s.content)
        .join('\n\n')
        .trim();

      const resultado = await executeAgentAction(segment.content, {
        ...actionCtx,
        textoContexto: textoAnterior,
      });

      if (resultado?.tokensExtras) {
        chatResult.totalTokens += resultado.tokensExtras;
      }
    }
  }

  if (agentConfig.redisUrl && job.telefone) {
    await clearGroupingKey(agentConfig.redisUrl, job.telefone);
  }

  await saveAgentTokenUsage(agente.id, chatResult.totalTokens, chatResult.model);

  logger.info('Agente IA processado', {
    canal: job.canal,
    conversaId: job.conversaId,
    segments: segments.length,
    totalTokens: chatResult.totalTokens,
  });
}

export function createAgentWorker() {
  return { processAgentJob };
}
