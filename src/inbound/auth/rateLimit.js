import { logger } from '../../logger.js';
import { envInt } from '../seguranca/env.js';
import { ipDoCliente, ipLiberado } from '../seguranca/ip.js';
import { PESO, registrarInfracao } from '../seguranca/jail.js';

export { envInt, ipDoCliente };

/**
 * Limite simples em memória por janela fixa. Suficiente para uma réplica do
 * inbound; com várias réplicas cada uma conta separado (limite efetivo maior).
 * IPs internos/liberados não são limitados. Estourar o limite soma pontos no jail.
 */
export function limitarTaxa({ nome, max, janelaMs, chave = ipDoCliente }) {
  const contadores = new Map();

  setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of contadores) if (v.reinicia <= agora) contadores.delete(k);
  }, janelaMs).unref();

  return (req, res, next) => {
    const ip = ipDoCliente(req);
    if (ipLiberado(ip)) return next();

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
      if (atual.total === max + 1) {
        logger.warn(`[rate-limit] ${nome} excedido`, { chave: k, ip, max });
        // Pontua uma vez por janela: só abuso contínuo leva ao ban.
        registrarInfracao(ip, PESO.LIMITE_EXCEDIDO, `limite ${nome}`);
      }
      return res.status(429).json({ ok: false, error: 'Muitas tentativas. Tente novamente mais tarde.' });
    }
    return next();
  };
}
