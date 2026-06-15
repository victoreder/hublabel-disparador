import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { createWorker } from './worker.js';

const app = express();
const worker = createWorker();
const startedAt = new Date().toISOString();

app.get('/health', (_req, res) => {
  const stats = worker.getStats();
  res.status(200).json({
    ok: true,
    service: 'hublabel-disparador-meta',
    startedAt,
    worker: stats,
  });
});

app.get('/', (_req, res) => {
  res.redirect('/health');
});

async function main() {
  await worker.start();

  app.listen(config.port, () => {
    logger.info('HTTP server ouvindo', { port: config.port, health: `/health` });
  });

  const shutdown = async (signal) => {
    logger.info('Encerrando', { signal });
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Falha fatal ao iniciar', { message: error.message, stack: error.stack });
  process.exit(1);
});
