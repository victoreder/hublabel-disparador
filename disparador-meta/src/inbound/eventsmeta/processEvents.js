import { logger } from '../../logger.js';
import { processMetaEvent } from '../../supabase.js';
import { buildAgentJobFromMetaResult } from '../agent/job.js';
import { enqueueAgentJob } from '../agent/queue.js';
import { extractMediaJobs } from './parseEvents.js';
import { processMediaJob } from './mediaPipeline.js';

/** Processa eventos em background (após responder 200 à Meta). */
export async function processEventsAsync(events, inboundConfig) {
  if (!events.length) return;

  const mediaJobs = extractMediaJobs(events);

  await Promise.all([
    processAllEvents(events),
    processAllMediaJobs(mediaJobs, inboundConfig),
  ]);
}

async function processAllEvents(events) {
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
      } else if (result?.segueFluxoIA) {
        enqueueAgentJob(buildAgentJobFromMetaResult(result));
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

      if (result?.segueFluxoIA) {
        enqueueAgentJob(buildAgentJobFromMetaResult(result));
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
