import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from '../../logger.js';
import { envInt } from './env.js';

/**
 * Proteção contra sobrecarga do processo:
 *  - monitora o atraso do event loop; acima de SOBRECARGA_LAG_MS (250 ms) o
 *    servidor está engasgado e passa a recusar (503) o que não é essencial,
 *    preservando webhooks da Meta/Evolution e o agente;
 *  - limitarConcorrencia: no máximo N execuções simultâneas de uma rota pesada
 *    (IA, upload), com fila curta; o excedente recebe 503 na hora em vez de
 *    acumular memória/CPU até derrubar o container.
 */

let sobrecarregado = false;
let lagAtualMs = 0;

export function iniciarMonitorSobrecarga() {
  const limiteMs = envInt('SOBRECARGA_LAG_MS', 250);
  const histograma = monitorEventLoopDelay({ resolution: 20 });
  histograma.enable();

  setInterval(() => {
    lagAtualMs = histograma.mean / 1e6;
    histograma.reset();
    const antes = sobrecarregado;
    sobrecarregado = lagAtualMs > limiteMs;
    if (sobrecarregado !== antes) {
      logger.warn(sobrecarregado ? '[sobrecarga] ativada' : '[sobrecarga] normalizada', {
        lagMs: Math.round(lagAtualMs),
        limiteMs,
      });
    }
  }, 1000).unref();
}

export function estadoSobrecarga() {
  return { sobrecarregado, lagMs: Math.round(lagAtualMs) };
}

/** Recusa requisições não essenciais enquanto o processo está sobrecarregado. */
export function recusarSeSobrecarregado({ essencial }) {
  return (req, res, next) => {
    if (!sobrecarregado || essencial(req)) return next();
    res.set('Retry-After', '5');
    return res.status(503).json({ ok: false, error: 'Servidor ocupado. Tente novamente em instantes.' });
  };
}

/** Bulkhead: limita execuções simultâneas (com fila) de uma rota pesada. */
export function limitarConcorrencia({ nome, max, fila = max * 4 }) {
  let ativos = 0;
  const esperando = [];

  const liberar = () => {
    ativos -= 1;
    const proximo = esperando.shift();
    if (proximo) proximo();
  };

  return (req, res, next) => {
    const iniciar = () => {
      ativos += 1;
      let liberado = false;
      const fim = () => {
        if (liberado) return;
        liberado = true;
        liberar();
      };
      res.on('finish', fim);
      res.on('close', fim);
      next();
    };

    if (ativos < max) return iniciar();
    if (esperando.length >= fila) {
      logger.warn('[sobrecarga] fila cheia', { rota: nome, ativos, fila: esperando.length });
      res.set('Retry-After', '10');
      return res.status(503).json({ ok: false, error: 'Muitas solicitações ao mesmo tempo. Tente em instantes.' });
    }
    esperando.push(iniciar);
    // Cliente desistiu enquanto esperava: sai da fila.
    req.on('close', () => {
      const idx = esperando.indexOf(iniciar);
      if (idx >= 0) esperando.splice(idx, 1);
    });
    return undefined;
  };
}
