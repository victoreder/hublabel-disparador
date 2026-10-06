import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { isContaAtiva, supabase } from '../../supabase.js';

/**
 * Autorização das ações chamadas pelas telas.
 *
 * As telas mandam o token da sessão do Supabase no header `X-Hub-Session`
 * (injetado automaticamente — ver paginas/authScript.js); `Authorization:
 * Bearer` também é aceito. Aqui o token é
 * validado no Supabase Auth e o usuário é buscado em SAAS_Usuarios para saber
 * o nível: super_admin, admin da conta (funcao = 'admin') ou usuário comum.
 *
 * Integrações externas (sem tela) podem usar o header `x-api-key` com o valor
 * de HUB_API_KEY, que vale como super admin.
 */

export const NIVEL = Object.freeze({
  LOGADO: 'logado',
  ADMIN_CONTA: 'adminConta',
  SUPER_ADMIN: 'superAdmin',
});

/**
 * Rotas que exigem sessão, com o nível mínimo. Fonte única: usada no registro
 * das rotas e no script que as telas recebem para anexar o token.
 */
export const ROTAS_PROTEGIDAS = Object.freeze({
  '/criar-usuario': NIVEL.SUPER_ADMIN,
  '/excluir-conta': NIVEL.SUPER_ADMIN,
  '/personalizar-saas': NIVEL.SUPER_ADMIN,
  '/criar-pv': NIVEL.SUPER_ADMIN,
  '/personalizar-pv': NIVEL.SUPER_ADMIN,
  '/personalizar-pagina': NIVEL.SUPER_ADMIN,
  '/sincronizar-supabase': NIVEL.SUPER_ADMIN,
  '/email-supabase': NIVEL.SUPER_ADMIN,
  '/alterar-credencial-smtp': NIVEL.SUPER_ADMIN,
  '/adicionar-usuario': NIVEL.ADMIN_CONTA,
  '/uploadmedia': NIVEL.LOGADO,
  '/gerarmensagem-ia': NIVEL.LOGADO,
  '/criar-instrucao': NIVEL.LOGADO,
  '/testar-openai': NIVEL.LOGADO,
  '/enviar-teste-email': NIVEL.LOGADO,
  '/enviar-template': NIVEL.LOGADO,
  '/inserir-conhecimento': NIVEL.LOGADO,
});

/** Middleware da rota conforme ROTAS_PROTEGIDAS (erro na subida se a rota não estiver lá). */
export function protegida(path) {
  const nivel = ROTAS_PROTEGIDAS[path];
  if (!nivel) throw new Error(`Rota ${path} não está em ROTAS_PROTEGIDAS`);
  return exigir(nivel);
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 2000;
const sessoes = new Map();

export class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

/** Token da sessão: header X-Hub-Session (telas) ou Authorization: Bearer (integrações). */
function tokenDaSessao(req) {
  const proprio = String(req.headers['x-hub-session'] ?? '').trim();
  if (proprio) return proprio;
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function apiKeyValida(req) {
  const esperada = process.env.HUB_API_KEY?.trim();
  const recebida = String(req.headers['x-api-key'] ?? '').trim();
  if (!esperada || !recebida) return false;
  const a = Buffer.from(esperada);
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Valida o JWT da sessão direto no Supabase Auth (GET /auth/v1/user). */
async function buscarAuthUser(token) {
  const apikey = process.env.SUPABASE_ANON_KEY?.trim() || config.supabaseServiceRoleKey;
  const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new AuthError(`Falha ao validar sessão (${res.status})`, 503);
  const user = await res.json().catch(() => null);
  return user?.id ? user : null;
}

async function buscarUsuario(authUserId) {
  const { data, error } = await supabase
    .from('SAAS_Usuarios')
    .select('id, contaId, funcao, super_admin')
    .eq('auth_user_id', authUserId)
    .limit(1)
    .maybeSingle();
  if (error) throw new AuthError(`Erro ao buscar usuário: ${error.message}`, 503);
  return data;
}

function guardarCache(token, valor) {
  if (sessoes.size >= CACHE_MAX) {
    const agora = Date.now();
    for (const [k, v] of sessoes) if (v.expira <= agora) sessoes.delete(k);
    if (sessoes.size >= CACHE_MAX) sessoes.delete(sessoes.keys().next().value);
  }
  sessoes.set(token, { valor, expira: Date.now() + CACHE_TTL_MS });
}

/** Quem está chamando: { authUserId, usuarioId, contaId, funcao, superAdmin, viaApiKey }. */
export async function identificar(req) {
  if (apiKeyValida(req)) {
    return { authUserId: null, usuarioId: null, contaId: null, funcao: 'admin', superAdmin: true, viaApiKey: true };
  }

  const token = tokenDaSessao(req);
  if (!token) throw new AuthError('Sessão ausente. Faça login novamente.', 401);

  const cached = sessoes.get(token);
  if (cached && cached.expira > Date.now()) return cached.valor;

  const authUser = await buscarAuthUser(token);
  if (!authUser) throw new AuthError('Sessão inválida ou expirada. Faça login novamente.', 401);

  const usuario = await buscarUsuario(authUser.id);
  if (!usuario) throw new AuthError('Usuário sem cadastro no sistema.', 403);

  const identidade = {
    authUserId: authUser.id,
    usuarioId: usuario.id,
    contaId: usuario.contaId ?? null,
    funcao: usuario.funcao ?? null,
    superAdmin: usuario.super_admin === true,
    viaApiKey: false,
  };
  guardarCache(token, identidade);
  return identidade;
}

export async function verificarNivel(identidade, nivel) {
  if (identidade.superAdmin) return;

  if (nivel === NIVEL.SUPER_ADMIN) throw new AuthError('Ação permitida só para o super admin.', 403);
  if (nivel === NIVEL.ADMIN_CONTA && identidade.funcao !== 'admin') {
    throw new AuthError('Ação permitida só para administradores da conta.', 403);
  }
  if (!identidade.contaId || !(await isContaAtiva(identidade.contaId))) {
    throw new AuthError('Conta bloqueada ou inativa.', 403);
  }
}

/** Middleware: exige sessão válida com o nível pedido e coloca `req.usuario`. */
export function exigir(nivel) {
  return async (req, res, next) => {
    try {
      const identidade = await identificar(req);
      await verificarNivel(identidade, nivel);
      req.usuario = identidade;
      return next();
    } catch (error) {
      const status = error instanceof AuthError ? error.statusCode : 500;
      if (status >= 500) logger.error('[auth] erro ao autorizar', { path: req.path, message: error.message });
      else logger.warn('[auth] negado', { path: req.path, status, message: error.message });
      return res.status(status).json({ ok: false, error: error.message });
    }
  };
}
