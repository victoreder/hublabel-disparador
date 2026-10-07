import { logger } from '../../logger.js';
import { envInt } from './env.js';
import { ipDoCliente, ipLiberado } from './ip.js';
import { definir, incrementar, segundosRestantes } from './store.js';

/**
 * "fail2ban" dentro da aplicação: cada comportamento suspeito soma pontos
 * para o IP; passou do limite na janela, o IP fica banido por um tempo e
 * todas as requisições dele são recusadas logo na entrada.
 *
 *   JAIL_LIMITE_PONTOS (30) pontos em JAIL_JANELA_MIN (10) min → ban de JAIL_BAN_MIN (60) min
 */

export const PESO = Object.freeze({
  NAO_ENCONTRADO: 1, // 404
  SESSAO_INVALIDA: 1, // token apresentado e recusado pelo Supabase
  SEM_PERMISSAO: 2, // usuário comum tentando rota de admin
  API_KEY_INVALIDA: 5, // tentativa de adivinhar HUB_API_KEY
  LIMITE_EXCEDIDO: 2, // 429 (uma vez por janela estourada)
  LOGIN_FALHO: 3,
  TOKEN_WEBHOOK_INVALIDO: 3,
  VARREDURA: 15, // /.env, /wp-login.php, /.git ...
});

const cfg = () => ({
  limite: envInt('JAIL_LIMITE_PONTOS', 30),
  janelaSeg: envInt('JAIL_JANELA_MIN', 10) * 60,
  banSeg: envInt('JAIL_BAN_MIN', 60) * 60,
});

export async function registrarInfracao(ip, peso, motivo) {
  if (!ip || ipLiberado(ip)) return;
  try {
    const { limite, janelaSeg, banSeg } = cfg();
    const pontos = await incrementar(`jail:pontos:${ip}`, janelaSeg, peso);
    if (pontos >= limite && pontos - peso < limite) {
      await definir(`jail:ban:${ip}`, motivo, banSeg);
      cacheBan.set(ip, { validoAte: Date.now() + CACHE_BAN_MS, banAte: Date.now() + banSeg * 1000 });
      logger.warn('[seguranca] IP banido', { ip, motivo, pontos, banMin: banSeg / 60 });
    }
  } catch (error) {
    logger.warn('[seguranca] falha ao registrar infração', { ip, message: error.message });
  }
}

export function infracao(req, peso, motivo) {
  return registrarInfracao(ipDoCliente(req), peso, motivo);
}

// Cache curto por IP para não consultar o Redis a cada requisição.
const cacheBan = new Map();
const CACHE_BAN_MS = 10_000;

export async function segundosDeBan(ip) {
  if (ipLiberado(ip)) return 0;
  const agora = Date.now();
  const cached = cacheBan.get(ip);
  if (cached && cached.validoAte > agora) {
    return Math.max(0, Math.ceil((cached.banAte - agora) / 1000));
  }
  const restante = await segundosRestantes(`jail:ban:${ip}`);
  if (cacheBan.size > 10_000) cacheBan.clear();
  cacheBan.set(ip, { validoAte: agora + CACHE_BAN_MS, banAte: agora + restante * 1000 });
  return restante;
}

/** Primeiro middleware: IP banido nem chega nas rotas. */
export function bloquearBanidos() {
  return async (req, res, next) => {
    try {
      const restante = await segundosDeBan(ipDoCliente(req));
      if (restante > 0) {
        res.set('Retry-After', String(restante));
        return res.status(403).json({ ok: false, error: 'Acesso bloqueado temporariamente.' });
      }
    } catch {
      // nunca derruba a requisição por falha no controle
    }
    return next();
  };
}

/** Caminhos que só robôs de invasão procuram. */
const VARREDURA_RE =
  /(^|\/)(\.env|\.git|\.svn|\.htaccess|\.aws|\.ssh|wp-(admin|login|content|includes)|xmlrpc\.php|phpmyadmin|pma|cgi-bin|vendor\/phpunit|actuator|server-status|boaform|\.DS_Store)|\.(php|asp|aspx|jsp|cgi)$/i;

export function detectarVarredura() {
  return (req, res, next) => {
    if (VARREDURA_RE.test(req.path)) {
      infracao(req, PESO.VARREDURA, `varredura ${req.path.slice(0, 80)}`);
      return res.status(404).end();
    }
    return next();
  };
}
