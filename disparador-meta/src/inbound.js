import express from 'express';
import { processAgentJob } from './inbound/agent/worker.js';
import { drainAgentQueue, getAgentQueueSize, startAgentQueueLoop } from './inbound/agent/queue.js';
import { getInboundConfig } from './inbound/config.js';
import { registerEventsMetaRoutes } from './inbound/routes/eventsmeta.js';
import { registerEvolutionRoutes } from './inbound/routes/evolution.js';
import { registerMetaApiRoutes, startMetaTokenRenewalCron } from './inbound/routes/metaApi.js';
import { logger } from './logger.js';
import { getSupabaseKeyInfo, validateSupabaseConnection, fetchOpenAIApiKey } from './supabase.js';

const startedAt = new Date().toISOString();

async function main() {
  const inboundConfig = getInboundConfig();
  await validateSupabaseConnection();
  await fetchOpenAIApiKey();
  logger.info('Supabase conectado (inbound)', getSupabaseKeyInfo());

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  app.locals.inboundConfig = inboundConfig;

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'hublabel-disparador-inbound',
      startedAt,
      agentQueue: getAgentQueueSize(),
      backUrl: inboundConfig.backUrl,
      publicWebhookUrls: inboundConfig.publicWebhookUrls,
      routes: {
        eventsMeta: inboundConfig.eventsMetaPath,
        evolution: inboundConfig.evolutionWebhookPath,
        metaApi: inboundConfig.metaApiPaths,
        slugs: inboundConfig.webhookPaths,
      },
    });
  });

  app.get('/', (_req, res) => {
    res.redirect('/health');
  });

  registerEventsMetaRoutes(app, {
    path: inboundConfig.eventsMetaPath,
    inboundConfig,
  });

  registerEvolutionRoutes(app, {
    path: inboundConfig.evolutionWebhookPath,
  });

  registerMetaApiRoutes(app, {
    paths: inboundConfig.metaApiPaths,
    inboundConfig,
  });

  startMetaTokenRenewalCron(inboundConfig);

  startAgentQueueLoop(async (job) => {
    await processAgentJob(job);
  }, inboundConfig.agentPollMs);

  app.listen(inboundConfig.port, () => {
    logger.info('Inbound server ouvindo', {
      port: inboundConfig.port,
      backUrl: inboundConfig.backUrl,
      health: '/health',
      publicWebhookUrls: inboundConfig.publicWebhookUrls,
    });
  });

  const shutdown = async () => {
    await drainAgentQueue(processAgentJob);
  };

  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
}

main().catch((error) => {
  logger.error('Falha fatal ao iniciar inbound', { message: error.message, stack: error.stack });
  process.exit(1);
});
