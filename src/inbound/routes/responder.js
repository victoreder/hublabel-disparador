import { logger } from '../../logger.js';
import { AuthAdminError } from '../acoes/usuarios.js';
import { HttpError } from '../meta/httpError.js';

/** Mesmo comportamento dos webhooks do n8n: aceita chamadas de qualquer origem. */
export function allowCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hub-Session, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

/**
 * Executa a ação e responde JSON. Erros viram { ok:false, error } com o status
 * do HttpError; erros do Supabase Auth mantêm o formato { error: { message } }
 * que as telas de cadastro já interpretam.
 */
export async function responder(res, fn, { tag = 'acao', authErrorAsString = false } = {}) {
  try {
    const result = await fn();
    if (res.headersSent) return undefined;
    return res.status(200).json(result ?? { ok: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) logger.error(`[${tag}] erro`, { status, message, stack: error?.stack });
    else logger.warn(`[${tag}] rejeitado`, { status, message });

    if (res.headersSent) return undefined;
    if (error instanceof AuthAdminError && !authErrorAsString) {
      return res.status(status).json(error.toJSON());
    }
    return res.status(status).json({ ok: false, error: message });
  }
}

/**
 * Registra POST (com CORS e preflight) que responde o JSON retornado por `fn(req)`.
 * `middlewares` roda antes (ex.: protegida(path), limitarTaxa(...)).
 */
export function postJson(app, path, fn, { middlewares = [], ...options } = {}) {
  app.options(path, allowCors);
  app.post(path, allowCors, ...middlewares, (req, res) =>
    responder(res, () => fn(req), { tag: path.replace(/^\//, ''), ...options }),
  );
}
