import express from 'express';
import { startFollowupCron } from './inbound/agent/followup/index.js';
import { processAgentJob } from './inbound/agent/worker.js';
import { drainAgentQueue, getAgentQueueSize, startAgentQueueLoop } from './inbound/agent/queue.js';
import { getInboundConfig } from './inbound/config.js';
import { registerEventsMetaRoutes } from './inbound/routes/eventsmeta.js';
import { registerEvolutionRoutes } from './inbound/routes/evolution.js';
import { registerMetaApiRoutes, startMetaTokenRenewalCron } from './inbound/routes/metaApi.js';
import { registerRagRoutes } from './inbound/routes/rag.js';
import { registerGerarEmailRoutes } from './inbound/routes/gerarEmail.js';
import { registerSyncTemplatesRoutes } from './inbound/routes/syncTemplates.js';
import { registerAcoesRoutes } from './inbound/routes/acoes.js';
import { registerPaginasRoutes } from './inbound/routes/paginas.js';
import { aplicarSeguranca, registrar404 } from './inbound/seguranca/middlewares.js';
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

  // Com o domínio inteiro apontando para este serviço, o prefixo do BACK_URL
  // (ex.: /webhook) é removido aqui mesmo — funciona com ou sem StripPrefix no Traefik.
  const basePath = inboundConfig.basePath;
  if (basePath) {
    app.use((req, _res, next) => {
      if (req.url === basePath || req.url.startsWith(`${basePath}/`) || req.url.startsWith(`${basePath}?`)) {
        req.url = req.url.slice(basePath.length) || '/';
        if (req.url.startsWith('?')) req.url = `/${req.url}`;
      }
      next();
    });
  }

  // Ban (jail), varredura, cabeçalhos, sobrecarga e limite global por IP.
  aplicarSeguranca(app, { inboundConfig });

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
        rag: inboundConfig.ragPath,
        syncTemplates: inboundConfig.syncTemplatesPath,
        gerarEmail: inboundConfig.gerarEmailPath,
        slugs: inboundConfig.webhookPaths,
      },
    });
  };

  app.get('/health', healthHandler);

  app.get('/', (_req, res) => {
    res.redirect(`${inboundConfig.backUrl}/login`);
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

  registerRagRoutes(app, {
    path: inboundConfig.ragPath,
    parentPath: inboundConfig.evolutionWebhookPath,
  });

  registerSyncTemplatesRoutes(app, {
    path: inboundConfig.syncTemplatesPath,
    parentPath: inboundConfig.evolutionWebhookPath,
  });

  registerGerarEmailRoutes(app, {
    path: inboundConfig.gerarEmailPath,
    parentPath: inboundConfig.evolutionWebhookPath,
  });

  registerPaginasRoutes(app, { inboundConfig });
  registerAcoesRoutes(app, { inboundConfig });

  logger.info('[inbound] rotas Meta registradas', inboundConfig.metaApiPaths);
  logger.info('[inbound] rota RAG registrada', {
    path: inboundConfig.ragPath,
    publicUrl: inboundConfig.publicWebhookUrls.inserirConhecimento,
  });
  logger.info('[inbound] rota sincronizar-templates registrada', {
    path: inboundConfig.syncTemplatesPath,
    publicUrl: inboundConfig.publicWebhookUrls.sincronizarTemplates,
  });
  logger.info('[inbound] rota gerar-email registrada', {
    path: inboundConfig.gerarEmailPath,
    publicUrl: inboundConfig.publicWebhookUrls.gerarEmail,
  });

  startMetaTokenRenewalCron(inboundConfig);
  startFollowupCron();

  startAgentQueueLoop(async (job) => {
    await processAgentJob(job);
  }, inboundConfig.agentPollMs);

  app.use((req, res) => {
    registrar404(req);
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
    // Erro inesperado não expõe detalhes internos (mensagem completa fica no log).
    res.status(status).json({
      ok: false,
      error: status < 500 && err instanceof Error ? err.message : 'Erro interno',
    });
  });

  const server = app.listen(inboundConfig.port, () => {
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

  // Conexões lentas/presas não seguram recursos para sempre.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

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
