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
import { sendAgentChunk, notifyTokenUsage } from './sendReply.js';

export async function processAgentJob(job) {
  const configIA = await fetchConfigIA();
  const agentConfig = getAgentConfig(configIA);
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

  const output = await runAgentChat({
    agentConfig,
    job,
    agente,
    systemPrompt,
    history,
    userMessage: inputText,
  });

  if (!output) {
    logger.warn('Agente IA sem resposta', { conversaId: job.conversaId });
    return;
  }

  const chunks = splitAgentOutput(output, agente.separarMensagens !== false);

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

  await notifyTokenUsage(job, agentConfig);

  logger.info('Agente IA processado', {
    canal: job.canal,
    conversaId: job.conversaId,
    chunks: chunks.length,
  });
}

export function createAgentWorker() {
  return { processAgentJob };
}
