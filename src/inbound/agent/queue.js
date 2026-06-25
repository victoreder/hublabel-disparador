import { logger } from '../../logger.js';

const queue = [];
let running = false;

export function enqueueAgentJob(job) {
  queue.push(job);
  logger.info('Agent queue: job adicionado', {
    canal: job?.canal,
    conexaoId: job?.conexaoId,
    conversaId: job?.conversaId,
    agenteId: job?.agenteId,
    queueSize: queue.length,
  });
  return queue.length;
}

export function getAgentQueueSize() {
  return queue.length;
}

export async function drainAgentQueue(processor) {
  if (running) return;
  running = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      logger.info('Agent queue: processando job', {
        canal: job?.canal,
        conexaoId: job?.conexaoId,
        conversaId: job?.conversaId,
        agenteId: job?.agenteId,
        restante: queue.length,
      });
      try {
        await processor(job);
      } catch (error) {
        logger.error('Agent queue: job falhou', {
          conversaId: job?.conversaId,
          message: error.message,
          stack: error.stack,
        });
      }
    }
  } finally {
    running = false;
  }
}

export function startAgentQueueLoop(processor, intervalMs = 500) {
  setInterval(() => {
    drainAgentQueue(processor).catch(() => {});
  }, intervalMs);
}
