import { logger } from '../../logger.js';

/** IP real do cliente (atrás do Traefik vem em X-Forwarded-For). */
export function ipDoCliente(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'desconhecido';
}

/**
 * Limite simples em memória por janela fixa. Suficiente para uma réplica do
 * inbound; com várias réplicas cada uma conta separado (limite efetivo maior).
 */
export function limitarTaxa({ nome, max, janelaMs, chave = ipDoCliente }) {
  const contadores = new Map();

  setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of contadores) if (v.reinicia <= agora) contadores.delete(k);
  }, janelaMs).unref();

  return (req, res, next) => {
    const agora = Date.now();
    const k = chave(req);
    let atual = contadores.get(k);
    if (!atual || atual.reinicia <= agora) {
      atual = { total: 0, reinicia: agora + janelaMs };
      contadores.set(k, atual);
    }
    atual.total += 1;

    if (atual.total > max) {
      const segundos = Math.ceil((atual.reinicia - agora) / 1000);
      res.set('Retry-After', String(segundos));
      if (atual.total === max + 1) logger.warn(`[rate-limit] ${nome} excedido`, { chave: k, max });
      return res.status(429).json({ ok: false, error: 'Muitas tentativas. Tente novamente mais tarde.' });
    }
    return next();
  };
}

export function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
