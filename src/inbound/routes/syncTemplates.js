import { logger } from '../../logger.js';
import { HttpError } from '../meta/httpError.js';
import { handleSyncTemplates } from '../meta/templates.js';

function normalizeAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isSyncTemplatesAction(value) {
  const acao = normalizeAction(value);
  return (
    acao === 'sincronizartemplates' ||
    acao === 'sincronizartemplate' ||
    acao === 'synctemplates' ||
    acao === 'puxartemplates'
  );
}

export function isSyncTemplatesRequest(req) {
  const path = String(req.path || req.originalUrl || '');
  if (path.includes('sincronizar-templates')) return true;

  const query = req.query ?? {};
  if (isSyncTemplatesAction(query.acao ?? query.action)) return true;

  const body = req.body ?? {};
  if (isSyncTemplatesAction(body.acao ?? body.action)) return true;

  return false;
}

function sanitizeBody(body = {}) {
  return {
    conexaoId: body.conexaoId ?? body.conexao_id ?? body.idConexao ?? null,
    acao: body.acao ?? body.action ?? null,
  };
}

export function handleSyncTemplatesRequest(req, res) {
  const startedAt = Date.now();
  const safeBody = sanitizeBody(req.body);
  const inboundConfig = req.app.locals.inboundConfig;

  logger.info('[sincronizar-templates] hit', {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    body: safeBody,
    queryAcao: req.query?.acao ?? req.query?.action ?? null,
  });

  handleSyncTemplates(req.body ?? {}, inboundConfig)
    .then((result) => {
      logger.info('[sincronizar-templates] ok', {
        durationMs: Date.now() - startedAt,
        conexaoId: result.conexaoId,
        totalMeta: result.totalMeta,
        totalSalvos: result.totalSalvos,
      });
      res.status(200).json(result);
    })
    .catch((error) => {
      const status = error instanceof HttpError ? error.statusCode : 500;
      const logPayload = {
        durationMs: Date.now() - startedAt,
        status,
        message: error instanceof Error ? error.message : String(error),
        body: safeBody,
      };

      if (status >= 500) {
        logger.error('[sincronizar-templates] erro', {
          ...logPayload,
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else {
        logger.warn('[sincronizar-templates] rejeitado', logPayload);
      }

      res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      });
    });
}

export function registerSyncTemplatesRoutes(app, { path, parentPath }) {
  logger.info('[sincronizar-templates] registrando sub-rota', { path, parentPath });
  app.post(path, handleSyncTemplatesRequest);
}
