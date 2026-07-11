import { logger } from '../../logger.js';
import { handleEvolutionWebhook } from '../evolution/handler.js';
import {
  handleRagIngestRequest,
  isRagIngestRequest,
  parseRagMultipart,
} from './rag.js';
import {
  handleSyncTemplatesRequest,
  isSyncTemplatesRequest,
} from './syncTemplates.js';

function isMultipartRequest(req) {
  return String(req.headers['content-type'] || '').toLowerCase().includes('multipart/form-data');
}

async function runEvolution(req, res, inboundConfig, startedAt) {
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
}

function evolutionHandler(inboundConfig) {
  return (req, res) => {
    const startedAt = Date.now();

    const dispatch = () => {
      const isRag = isRagIngestRequest(req);
      const isSyncTemplates = isSyncTemplatesRequest(req);

      logger.info('[evolution-webhook] hit', {
        method: req.method,
        path: req.path,
        originalUrl: req.originalUrl,
        idConexao: req.query?.idConexao ?? req.body?.idConexao ?? null,
        event: req.body?.event ?? null,
        instance: req.body?.instance ?? null,
        acao: req.body?.acao ?? req.query?.acao ?? null,
        isRag,
        isSyncTemplates,
      });

      if (isSyncTemplates) {
        return handleSyncTemplatesRequest(req, res);
      }

      if (isRag) {
        return handleRagIngestRequest(req, res);
      }

      return runEvolution(req, res, inboundConfig, startedAt);
    };

    if (isMultipartRequest(req)) {
      return parseRagMultipart(req, res, dispatch);
    }

    return dispatch();
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
