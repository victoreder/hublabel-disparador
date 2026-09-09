import { logger } from '../../../logger.js';
import { processarFollowupsPendentes } from './runtime.js';

let timer;
let rodando = false;

async function executar() {
  if (rodando) return;
  rodando = true;
  try {
    const n = await processarFollowupsPendentes(25);
    if (n > 0) logger.info('Follow-ups processados', { quantidade: n });
  } catch (err) {
    logger.warn('Cron follow-up', { message: err.message });
  } finally {
    rodando = false;
  }
}

export function startFollowupCron() {
  if (timer) return;
  const intervaloMs = 10_000;
  timer = setInterval(() => {
    void executar();
  }, intervaloMs);
  setTimeout(() => void executar(), 3_000);
  logger.info('Cron de follow-up do agente iniciado', { intervaloMs });
}

export function stopFollowupCron() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
