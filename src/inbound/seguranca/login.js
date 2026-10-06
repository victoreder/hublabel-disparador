import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { HttpError } from '../meta/httpError.js';
import { envInt } from './env.js';
import { ipDoCliente } from './ip.js';
import { PESO, registrarInfracao } from './jail.js';
import { definir, incrementar, remover, segundosRestantes } from './store.js';

/**
 * Login passando pelo servidor (POST /auth/login), para poder contar erros:
 *  - LOGIN_MAX_FALHAS (5) senhas erradas para o mesmo e-mail em
 *    LOGIN_JANELA_MIN (15) min → e-mail bloqueado por LOGIN_BLOQUEIO_MIN (15) min;
 *  - cada erro soma pontos para o IP no jail (muitos erros → IP banido).
 * Com sucesso devolve a sessão do Supabase; a tela grava com supabase.auth.setSession.
 */

const cfg = () => ({
  maxFalhas: envInt('LOGIN_MAX_FALHAS', 5),
  janelaSeg: envInt('LOGIN_JANELA_MIN', 15) * 60,
  bloqueioSeg: envInt('LOGIN_BLOQUEIO_MIN', 15) * 60,
});

function chaveEmail(email) {
  return createHash('sha256').update(email).digest('hex').slice(0, 32);
}

function minutos(segundos) {
  return Math.max(1, Math.ceil(segundos / 60));
}

async function senhaSupabase(email, password) {
  const apikey = process.env.SUPABASE_ANON_KEY?.trim() || config.supabaseServiceRoleKey;
  const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function login(req) {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password || email.length > 254 || password.length > 200) {
    throw new HttpError('Informe e-mail e senha.', 400);
  }

  const { maxFalhas, janelaSeg, bloqueioSeg } = cfg();
  const id = chaveEmail(email);
  const ip = ipDoCliente(req);

  const bloqueado = await segundosRestantes(`login:bloqueio:${id}`);
  if (bloqueado > 0) {
    throw new HttpError(
      `Muitas tentativas com senha errada. Tente novamente em ${minutos(bloqueado)} minuto(s).`,
      429,
    );
  }

  let resposta;
  try {
    resposta = await senhaSupabase(email, password);
  } catch (error) {
    logger.error('[login] Supabase Auth inacessível', { message: error.message });
    throw new HttpError('Serviço de login indisponível. Tente novamente.', 503);
  }
  const { status, json } = resposta;

  if (status === 200 && json?.access_token) {
    await remover(`login:falhas:${id}`);
    return {
      ok: true,
      session: {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_in: json.expires_in,
        expires_at: json.expires_at,
        token_type: json.token_type,
      },
    };
  }

  const codigo = String(json?.error_code || json?.code || json?.error || '');
  if (status === 429) throw new HttpError('Muitas tentativas. Aguarde alguns minutos.', 429);
  if (codigo === 'email_not_confirmed') throw new HttpError('E-mail ainda não confirmado.', 401);
  if (status >= 500) throw new HttpError('Serviço de login indisponível. Tente novamente.', 503);

  // Senha/e-mail inválidos: conta a falha.
  const falhas = await incrementar(`login:falhas:${id}`, janelaSeg);
  registrarInfracao(ip, PESO.LOGIN_FALHO, 'login falho');

  if (falhas >= maxFalhas) {
    await definir(`login:bloqueio:${id}`, '1', bloqueioSeg);
    await remover(`login:falhas:${id}`);
    logger.warn('[login] e-mail bloqueado por excesso de falhas', { emailHash: id, ip, falhas });
    throw new HttpError(
      `Muitas tentativas com senha errada. Login bloqueado por ${minutos(bloqueioSeg)} minutos.`,
      429,
    );
  }

  const restantes = maxFalhas - falhas;
  throw new HttpError(
    `E-mail ou senha incorretos. ${restantes} tentativa(s) restante(s) antes do bloqueio.`,
    401,
  );
}
