import { logger } from '../../logger.js';
import { handleEvolutionWebhook } from '../evolution/handler.js';

function evolutionHandler(inboundConfig) {
  return async (req, res) => {
    const startedAt = Date.now();
    logger.info('[evolution-webhook] hit', {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      idConexao: req.query?.idConexao ?? req.body?.idConexao ?? null,
      event: req.body?.event ?? null,
      instance: req.body?.instance ?? null,
    });

    try {
      const result = await handleEvolutionWebhook(req, inboundConfig);

      logger.info('[evolution-webhook] ok', {
        durationMs: Date.now() - startedAt,
        status: result.status,
        body: result.body,
      });

      res.status(result.status).json(result.body);
    } catch (error) {
      logger.error('[evolution-webhook] erro', {
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Erro desconhecido' });
    }
  };
}

export function registerEvolutionRoutes(app, { paths, inboundConfig }) {
  const routePaths = Array.isArray(paths) ? paths : [paths];
  const handler = evolutionHandler(inboundConfig);

  for (const path of routePaths) {
    app.post(path, handler);
  }

  logger.info('[evolution-webhook] rotas registradas', routePaths);
}
