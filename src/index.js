import express from 'express';
import { config } from './config.js';
import { createEmailWorker } from './email/worker.js';
import { logger } from './logger.js';
import { getSupabaseKeyInfo, validateSupabaseConnection } from './supabase.js';
import { createWorker } from './worker.js';

const app = express();
const worker = createWorker();
const emailWorker = createEmailWorker();
const startedAt = new Date().toISOString();

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'hublabel-disparador-meta',
    startedAt,
    worker: worker.getStats(),
    email: emailWorker.getStats(),
  });
});

app.get('/', (_req, res) => {
  res.redirect('/health');
});

async function main() {
  await validateSupabaseConnection();
  logger.info('Supabase conectado', getSupabaseKeyInfo());

  await worker.start();
  await emailWorker.start();

  app.listen(config.port, () => {
    logger.info('HTTP server ouvindo', { port: config.port, health: `/health` });
  });

  const shutdown = async (signal) => {
    logger.info('Encerrando', { signal });
    await Promise.all([worker.stop(), emailWorker.stop()]);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Falha fatal ao iniciar', { message: error.message, stack: error.stack });
  process.exit(1);
});
