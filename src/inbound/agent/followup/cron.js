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
  timer = setInterval(() => {
    void executar();
  }, 60_000);
  setTimeout(() => void executar(), 25_000);
  logger.info('Cron de follow-up do agente iniciado', { intervaloMs: 60_000 });
}

export function stopFollowupCron() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
