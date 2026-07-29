const queue = [];
let draining = false;

export function enqueueAgentJob(job) {
  queue.push(job);
  return queue.length;
}

export function getAgentQueueSize() {
  return queue.length;
}

/**
 * Dispara jobs em paralelo (não espera um acabar para começar o próximo).
 * Necessário para agrupar mensagens: durante o sleep do intervalo, outras
 * mensagens precisam conseguir fazer push no Redis.
 */
export async function drainAgentQueue(processor) {
  if (draining) return;
  draining = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      Promise.resolve()
        .then(() => processor(job))
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.error('Agent queue: job falhou', {
            conversaId: job?.conversaId,
            message: error?.message || String(error),
            stack: error?.stack,
          });
        });
    }
  } finally {
    draining = false;
  }
}

export function startAgentQueueLoop(processor, intervalMs = 500) {
  setInterval(() => {
    drainAgentQueue(processor).catch(() => {});
  }, intervalMs);
}
