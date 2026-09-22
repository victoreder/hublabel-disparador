import { logger } from '../../logger.js';
import { puxarContatosWpp } from '../conexao/grupos.js';
import { HttpError } from '../meta/httpError.js';

function normalizeAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function isPuxarContatosWppRequest(req) {
  const action = normalizeAction(
    req.body?.acao ?? req.body?.action ?? req.query?.acao ?? req.query?.action,
  );
  return action === 'puxarcontatoswpp';
}

export async function handlePuxarContatosWppRequest(req, res) {
  const startedAt = Date.now();
  try {
    const result = await puxarContatosWpp(
      req.body ?? {},
      req.app.locals.inboundConfig,
    );
    logger.info('[puxar-contatos-wpp] resposta HTTP enviada', {
      durationMs: Date.now() - startedAt,
      status: 200,
      provedorApi: result.provedorApi,
      total: result.total,
    });
    return res.status(200).json(result);
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    logger.error('[puxar-contatos-wpp] resposta HTTP com erro', {
      durationMs: Date.now() - startedAt,
      status,
      upstreamStatus: error?.status ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
}
