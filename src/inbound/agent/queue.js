const queue = [];
let running = false;

export function enqueueAgentJob(job) {
  queue.push(job);
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
      try {
        await processor(job);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[agent-queue] job failed', error);
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
