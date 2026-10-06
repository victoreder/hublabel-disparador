import net from 'node:net';

/**
 * IP real do cliente.
 * - CLIENT_IP_HEADER (ex.: cf-connecting-ip) quando há Cloudflare na frente.
 * - Senão, o último IP do X-Forwarded-For: é o que o Traefik viu na conexão
 *   (valores anteriores podem ter sido forjados pelo próprio cliente).
 */
export function ipDoCliente(req) {
  const headerProprio = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (headerProprio) {
    const valor = String(req.headers[headerProprio] ?? '').trim();
    if (valor) return normalizar(valor);
  }

  const cadeia = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cadeia.length) return normalizar(cadeia[cadeia.length - 1]);
  return normalizar(req.socket?.remoteAddress || 'desconhecido');
}

function normalizar(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Rede interna (Docker, localhost): nunca é limitada nem banida. */
export function ipInterno(ip) {
  if (!net.isIP(ip)) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

let liberados = null;

/** IPs internos + SEGURANCA_IPS_LIBERADOS (lista separada por vírgula). */
export function ipLiberado(ip) {
  if (!liberados) {
    liberados = new Set(
      String(process.env.SEGURANCA_IPS_LIBERADOS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return ipInterno(ip) || liberados.has(ip);
}
