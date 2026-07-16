import { logger } from '../../logger.js';
import { fetchConexaoById, processMetaEvent } from '../../supabase.js';
import { buildAgentJobFromMetaResult } from '../agent/job.js';
import { enqueueAgentJob } from '../agent/queue.js';
import { scheduleContatoFotoPerfilSync } from '../contato/fotoPerfil.js';
import { extractMediaJobs } from './parseEvents.js';
import { processMediaJob } from './mediaPipeline.js';

function scheduleFotoPerfilFromMetaResult(result, inboundConfig, conexao) {
  if (!result?.contatoId || !result?.telefone) return;

  scheduleContatoFotoPerfilSync({
    contatoId: result.contatoId,
    contatoCriado: Boolean(result.contatoCriado),
    telefone: result.telefone,
    fromMe: false,
    canal: 'meta',
    conexaoId: result.conexaoId,
    contaId: result.contaId,
    conexao,
    s3Config: inboundConfig.s3,
  });
}

async function loadConexaoForFotoPerfil(result) {
  if (!result?.conexaoId) return null;
  try {
    return await fetchConexaoById(result.conexaoId);
  } catch (error) {
    logger.warn('fotoPerfil: falha ao buscar conexão Meta', {
      conexaoId: result.conexaoId,
      message: error.message,
    });
    return null;
  }
}

/** Processa eventos em background (após responder 200 à Meta). */
export async function processEventsAsync(events, inboundConfig) {
  if (!events.length) return;

  const mediaJobs = extractMediaJobs(events);

  await Promise.all([
    processAllEvents(events, inboundConfig),
    processAllMediaJobs(mediaJobs, inboundConfig),
  ]);
}

async function processAllEvents(events, inboundConfig) {
  for (const event of events) {
    try {
      const result = await processMetaEvent({
        waba_id: event.waba_id,
        field: event.field,
        value: event.value,
        received_at: event.received_at,
      });

      if (result?.ok === false) {
        logger.warn('f_meta_processar_evento retornou erro', {
          field: event.field,
          waba_id: event.waba_id,
          error: result.error,
        });
        continue;
      }

      const conexao = await loadConexaoForFotoPerfil(result);
      scheduleFotoPerfilFromMetaResult(result, inboundConfig, conexao);

      if (result?.segueFluxoIA) {
        enqueueAgentJob(buildAgentJobFromMetaResult(result));
      } else {
        logger.info('Agente não enfileirado (meta)', {
          conversaId: result?.conversaId ?? null,
          contatoId: result?.contatoId ?? null,
          mensagemId: result?.mensagemId ?? null,
          segueFluxoIA: Boolean(result?.segueFluxoIA),
          parouPorPausado: Boolean(result?.parouPorPausado),
          creditoEsgotado: Boolean(result?.creditoEsgotado),
          agenteId: result?.agenteId ?? null,
          motivoAtivacao: result?.motivoAtivacao ?? null,
          skipped: Boolean(result?.skipped),
          chatOk: result?.ok !== false,
          chatError: result?.error ?? null,
        });
      }
    } catch (error) {
      logger.error('Erro ao processar evento Meta', {
        field: event.field,
        waba_id: event.waba_id,
        message: error.message,
      });
    }
  }
}

async function processAllMediaJobs(jobs, inboundConfig) {
  for (const job of jobs) {
    try {
      const result = await processMediaJob(job, {
        s3Config: inboundConfig.s3,
        metaGraphApiVersion: inboundConfig.metaGraphApiVersion,
      });

      const conexao = await loadConexaoForFotoPerfil(result);
      scheduleContatoFotoPerfilSync({
        contatoId: result?.contatoId,
        contatoCriado: Boolean(result?.contatoCriado),
        telefone: result?.telefone || job.telefone,
        fromMe: false,
        canal: 'meta',
        conexaoId: result?.conexaoId,
        contaId: result?.contaId,
        conexao,
        s3Config: inboundConfig.s3,
      });

      if (result?.segueFluxoIA) {
        enqueueAgentJob(buildAgentJobFromMetaResult(result));
      } else {
        logger.info('Agente não enfileirado (meta midia)', {
          conversaId: result?.conversaId ?? null,
          segueFluxoIA: Boolean(result?.segueFluxoIA),
          parouPorPausado: Boolean(result?.parouPorPausado),
          creditoEsgotado: Boolean(result?.creditoEsgotado),
          agenteId: result?.agenteId ?? null,
        });
      }
    } catch (error) {
      logger.error('Erro no pipeline de mídia Meta', {
        metaMessageId: job.meta_message_id,
        mediaId: job.media_id,
        message: error.message,
      });
    }
  }
}
