import multer from 'multer';
import { logger } from '../../logger.js';
import { HttpError } from '../meta/httpError.js';
import { ingestKnowledgeDocument } from '../rag/ingest.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number.parseInt(process.env.RAG_MAX_FILE_BYTES ?? '', 10) || 20 * 1024 * 1024,
  },
});

const uploadFields = upload.fields([
  { name: 'data', maxCount: 1 },
  { name: 'file', maxCount: 1 },
  { name: 'documento', maxCount: 1 },
]);

function sanitizeBody(body = {}) {
  return {
    userId: body.userId ?? body.contaId ?? null,
    idAgente: body.idAgente ?? body.id_agente ?? null,
    idUnico: body.idUnico ?? body.id_unico ?? null,
    acao: body.acao ?? null,
    hasText: Boolean(
      body.text ?? body.conteudo ?? body.descricao ?? body.documentoTexto ?? body.conhecimento,
    ),
  };
}

function pickUploadedFile(req) {
  return (
    req.file ??
    req.files?.data?.[0] ??
    req.files?.file?.[0] ??
    req.files?.documento?.[0] ??
    null
  );
}

function normalizeRagAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isRagAction(value) {
  const acao = normalizeRagAction(value);
  return acao === 'inserirdocumento' || acao === 'inserirconhecimento';
}

function isKnowledgeUploadPayload(body = {}) {
  const hasIdentity =
    Boolean(body.userId || body.contaId || body.conta_id) &&
    ((body.idAgente != null && body.idAgente !== '') ||
      body.id_agente != null ||
      body.agenteId != null) &&
    Boolean(body.idUnico || body.id_unico);

  const isEvolutionWebhook = Boolean(
    body.event || body.instance || (body.data && typeof body.data === 'object'),
  );

  return hasIdentity && !isEvolutionWebhook;
}

export function isRagIngestRequest(req) {
  const path = String(req.path || req.originalUrl || '');
  if (path.includes('inserir-conhecimento')) return true;

  const query = req.query ?? {};
  if (isRagAction(query.acao ?? query.action)) return true;

  const body = req.body ?? {};
  if (isRagAction(body.acao ?? body.action)) return true;

  return isKnowledgeUploadPayload(body);
}

function handleIngest(req, res) {
  const startedAt = Date.now();
  const safeBody = sanitizeBody(req.body);

  logger.info('[rag-inserir-conhecimento] hit', {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    contentType: req.headers['content-type'] || null,
    body: safeBody,
    hasFile: Boolean(pickUploadedFile(req)),
  });

  ingestKnowledgeDocument({
    body: req.body ?? {},
    file: pickUploadedFile(req),
  })
    .then((result) => {
      logger.info('[rag-inserir-conhecimento] ok', {
        durationMs: Date.now() - startedAt,
        idUnico: result.idUnico,
        chunks: result.chunks,
        deleted: result.deleted,
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
        logger.error('[rag-inserir-conhecimento] erro', {
          ...logPayload,
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else {
        logger.warn('[rag-inserir-conhecimento] rejeitado', logPayload);
      }

      res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      });
    });
}

function runWithMulter(req, res, onReady = () => handleIngest(req, res)) {
  uploadFields(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Arquivo excede o tamanho máximo permitido'
          : err.message;
      return res.status(400).json({ ok: false, error: message });
    }
    if (err) {
      logger.error('[rag-inserir-conhecimento] multer erro', {
        message: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ ok: false, error: 'Falha ao processar upload' });
    }
    req._ragMultipartParsed = true;
    return onReady();
  });
}

export function parseRagMultipart(req, res, next) {
  if (req._ragMultipartParsed) return next();
  return runWithMulter(req, res, next);
}

export function handleRagIngestRequest(req, res) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('multipart/form-data') && !req._ragMultipartParsed) {
    return runWithMulter(req, res);
  }
  return handleIngest(req, res);
}

export function registerRagRoutes(app, { path, parentPath }) {
  logger.info('[rag] registrando sub-rota', { path, parentPath });
  app.post(path, handleRagIngestRequest);
}
