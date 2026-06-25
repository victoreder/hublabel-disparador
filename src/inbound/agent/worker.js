import { logger } from '../../logger.js';
import { fetchAgente, fetchConfigIA } from '../../supabase.js';
import { getAgentConfig } from './config.js';
import { loadChatHistory } from './memory.js';
import { runAgentChat } from './openai.js';
import { splitAgentOutput } from './parseResponse.js';
import { buildSystemPrompt } from './prompt.js';
import { preprocessInput } from './preprocess.js';
import {
  clearGroupingKey,
  pushGroupingMessage,
  waitForGroupedText,
} from './redis.js';
import { sendAgentChunk } from './sendReply.js';
import { saveAgentTokenUsage } from './tokens.js';

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

  const agenteIdConexao = job.conexao?.idAgente ?? job.agenteId;
  const agente =
    job.agente ??
    (agenteIdConexao ? await fetchAgente(agenteIdConexao) : null);

  if (!agente) {
    logger.warn('Agent worker: agente não encontrado', {
      agenteId: job.agenteId,
      conversaId: job.conversaId,
      agenteNoJob: Boolean(job.agente),
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

  const chunks = splitAgentOutput(chatResult.content, agente.separarMensagens !== false);

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

  if (agentConfig.redisUrl && job.telefone) {
    await clearGroupingKey(agentConfig.redisUrl, job.telefone);
  }

  await saveAgentTokenUsage(agente.id, chatResult.totalTokens, chatResult.model);

  logger.info('Agente IA processado', {
    canal: job.canal,
    conversaId: job.conversaId,
    chunks: chunks.length,
    totalTokens: chatResult.totalTokens,
  });
}

export function createAgentWorker() {
  return { processAgentJob };
}
