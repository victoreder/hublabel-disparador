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

function sanitizeBody(body = {}) {
  return {
    userId: body.userId ?? body.contaId ?? null,
    idAgente: body.idAgente ?? body.id_agente ?? null,
    idUnico: body.idUnico ?? body.id_unico ?? null,
    hasText: Boolean(body.text ?? body.conteudo),
  };
}

function pickUploadedFile(req) {
  return req.file ?? req.files?.data?.[0] ?? req.files?.file?.[0] ?? null;
}

function handleIngest(req, res) {
  const startedAt = Date.now();
  const safeBody = sanitizeBody(req.body);

  logger.info('[rag-inserir-conhecimento] hit', {
    method: req.method,
    path: req.path,
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

export function registerRagRoutes(app, { path, parentPath }) {
  logger.info('[rag] registrando sub-rota', { path, parentPath });

  const uploadFields = upload.fields([
    { name: 'data', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]);

  app.post(path, (req, res, next) => {
    uploadFields(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Arquivo excede o tamanho máximo permitido'
            : err.message;
        return res.status(400).json({ ok: false, error: message });
      }
      if (err) return next(err);
      return handleIngest(req, res);
    });
  });
}
