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

  process.on('unhandledRejection', (reason) => {
    logger.error('[inbound] unhandledRejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('[inbound] uncaughtException', { message: error.message, stack: error.stack });
  });

  await validateSupabaseConnection();

  try {
    await fetchOpenAIApiKey();
    logger.info('OpenAI apikey carregada (SAAS_Config_IA)');
  } catch (error) {
    logger.warn('OpenAI apikey indisponivel no startup — agente IA pode falhar, rotas Meta seguem ativas', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('Supabase conectado (inbound)', getSupabaseKeyInfo());

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const isMeta =
        req.path.includes('meta') ||
        req.originalUrl.includes('meta') ||
        inboundConfig.metaApiPaths?.token === req.path;
      if (isMeta || req.method !== 'GET') {
        logger.info('[inbound] http', {
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }
    });
    next();
  });

  app.use(express.json({ limit: '5mb' }));
  app.locals.inboundConfig = inboundConfig;

  const healthHandler = (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'hublabel-disparador-inbound',
      startedAt,
      agentQueue: getAgentQueueSize(),
      backUrl: inboundConfig.backUrl,
      basePath: inboundConfig.basePath || null,
      traefikStripPrefix: inboundConfig.traefikStripPrefix || null,
      publicWebhookUrls: inboundConfig.publicWebhookUrls,
      traefikPaths: inboundConfig.traefikPaths,
      routes: {
        eventsMeta: inboundConfig.eventsMetaPath,
        evolution: inboundConfig.evolutionWebhookPath,
        evolutionLegacy: inboundConfig.evolutionWebhookLegacyPath,
        metaApi: inboundConfig.metaApiPaths,
        slugs: inboundConfig.webhookPaths,
      },
    });
  };

  app.get('/health', healthHandler);

  app.get('/', (_req, res) => {
    res.redirect('/health');
  });

  registerEventsMetaRoutes(app, {
    path: inboundConfig.eventsMetaPath,
    inboundConfig,
  });

  registerEvolutionRoutes(app, {
    paths: [inboundConfig.evolutionWebhookPath, inboundConfig.evolutionWebhookLegacyPath],
    inboundConfig,
  });

  registerMetaApiRoutes(app, {
    paths: inboundConfig.metaApiPaths,
    inboundConfig,
  });

  logger.info('[inbound] rotas Meta registradas', inboundConfig.metaApiPaths);

  startMetaTokenRenewalCron(inboundConfig);

  startAgentQueueLoop(async (job) => {
    await processAgentJob(job);
  }, inboundConfig.agentPollMs);

  app.use((req, res) => {
    logger.warn('[inbound] rota nao encontrada', {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
    });
    res.status(404).json({ ok: false, error: 'Rota nao encontrada' });
  });

  app.use((err, req, res, _next) => {
    const isJsonSyntax = err instanceof SyntaxError && 'body' in err;
    logger.error('[inbound] erro middleware', {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      message: err instanceof Error ? err.message : String(err),
      isJsonSyntax,
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (isJsonSyntax) {
      return res.status(400).json({ ok: false, error: 'JSON invalido no body' });
    }

    const status = err?.statusCode || err?.status || 500;
    res.status(status).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro interno',
    });
  });

  app.listen(inboundConfig.port, () => {
    logger.info('Inbound server ouvindo', {
      port: inboundConfig.port,
      backUrl: inboundConfig.backUrl,
      basePath: inboundConfig.basePath || null,
      traefikStripPrefix: inboundConfig.traefikStripPrefix || null,
      expressRoutes: {
        metaToken: inboundConfig.metaApiPaths.token,
        eventsMeta: inboundConfig.eventsMetaPath,
      },
      publicWebhookUrls: inboundConfig.publicWebhookUrls,
      traefikPaths: inboundConfig.traefikPaths,
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
