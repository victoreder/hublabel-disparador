import { logger } from '../../logger.js';
import { fetchAgente } from '../../supabase.js';
import { executeAgentAction } from './actions.js';
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

  let output;
  try {
    output = await runAgentChat({
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

  if (!output) {
    logger.warn('Agente IA sem resposta', { conversaId: job.conversaId });
    return;
  }

  const segments = parseAgentOutputWithActions(output);
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

  for (const segment of segments) {
    if (segment.type === 'action') {
      try {
        await executeAgentAction(segment.content, actionCtx);
        acoesExecutadas += 1;
      } catch (error) {
        logger.warn('Falha ao executar ação do agente — ignorado', {
          conversaId: job.conversaId,
          tipo: segment.content?.tipo,
          message: error.message,
        });
      }
      continue;
    }

    const textoLimpo = stripActionMarkers(segment.content);
    if (!textoLimpo) continue;

    const chunks = splitAgentOutput(textoLimpo, agente.separarMensagens !== false);
    for (const chunk of chunks) {
      const textoChunk = stripActionMarkers(chunk.text);
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

  await notifyTokenUsage(job, agentConfig);

  logger.info('Agente IA processado', {
    canal: job.canal,
    conversaId: job.conversaId,
    chunks: chunksEnviados,
    acoes: acoesExecutadas,
  });
}

export function createAgentWorker() {
  return { processAgentJob };
}
