import { supabase } from '../../supabase.js';
import { HttpError } from '../meta/httpError.js';

/** Plano dado no cadastro grátis (no n8n era fixo: plano 2, 2 dias). */
const PLANO_GRATIS_ID = Number.parseInt(process.env.PLANO_GRATIS_ID ?? '', 10) || 2;
const PLANO_GRATIS_DIAS = Number.parseInt(process.env.PLANO_GRATIS_DIAS ?? '', 10) || 2;
const TIMEZONE = process.env.TZ_SISTEMA?.trim() || 'America/Sao_Paulo';

/** Erro do Supabase Auth no formato que as telas já interpretam (`result.error.message`). */
export class AuthAdminError extends HttpError {
  constructor(error) {
    super(error?.message || 'Erro no Supabase Auth', Number(error?.status) || 400);
    this.code = error?.code ?? null;
  }

  toJSON() {
    return { error: { message: this.message, status: this.statusCode, code: this.code } };
  }
}

function texto(value) {
  if (value == null) return '';
  return String(value).trim();
}

export async function criarAuthUser({ email, password, userMetadata }) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: texto(email),
    password: String(password ?? ''),
    email_confirm: true,
    user_metadata: userMetadata,
  });
  if (error) throw new AuthAdminError(error);
  return data.user;
}

export async function excluirAuthUser(authUserId) {
  const id = texto(authUserId);
  if (!id) throw new HttpError('auth_user_id é obrigatório', 400);
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) throw new AuthAdminError(error);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SAAS_Usuarios é preenchido por trigger ao criar o auth user — tenta algumas vezes. */
export async function buscarUsuarioPorAuthId(authUserId) {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const { data, error } = await supabase
      .from('SAAS_Usuarios')
      .select('*')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (error) throw new HttpError(`Erro ao buscar SAAS_Usuarios: ${error.message}`, 500);
    if (data) return data;
    await sleep(400);
  }
  throw new HttpError('Usuário criado, mas não encontrado em SAAS_Usuarios', 500);
}

export async function buscarUsuarioPorEmail(email) {
  const { data, error } = await supabase
    .from('SAAS_Usuarios')
    .select('*')
    .eq('Email', texto(email).toLowerCase())
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(`Erro ao buscar SAAS_Usuarios: ${error.message}`, 500);
  return data;
}

export async function atualizarConta(contaId, fields) {
  if (!contaId) throw new HttpError('Usuário sem contaId', 500);
  const { data, error } = await supabase
    .from('SAAS_Contas')
    .update(fields)
    .eq('id', contaId)
    .select('*');
  if (error) throw new HttpError(`Erro ao atualizar SAAS_Contas: ${error.message}`, 500);
  return data?.[0] ?? null;
}

function offsetDoFuso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = name.match(/GMT([+-]\d{2}:\d{2})/);
  return match ? match[1] : '+00:00';
}

/** Equivalente ao `$today.plus(n, 'days')` do n8n: meia-noite local + n dias. */
export function hojeMaisDias(dias, now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = ymd.split('-').map(Number);
  const alvo = new Date(Date.UTC(y, m - 1, d + (Number(dias) || 0)));
  const iso = alvo.toISOString().slice(0, 10);
  return `${iso}T00:00:00.000${offsetDoFuso(alvo)}`;
}

/** POST /usuario-gratis (tela /cadastrar). */
export async function cadastrarUsuarioGratis(body = {}) {
  const user = await criarAuthUser({
    email: body.email,
    password: body.senha,
    userMetadata: { nome: texto(body.nome), telefone: texto(body.telefone) },
  });
  const usuario = await buscarUsuarioPorAuthId(user.id);
  return atualizarConta(usuario.contaId, {
    dataValidade: hojeMaisDias(PLANO_GRATIS_DIAS),
    plano: PLANO_GRATIS_ID,
    status: true,
  });
}

/** POST /criar-usuario (admin → criar cliente). */
export async function criarUsuarioAdmin(body = {}) {
  const user = await criarAuthUser({
    email: body.email,
    password: body.senha,
    userMetadata: { nome: texto(body.nome), telefone: texto(body.telefone) },
  });
  const usuario = await buscarUsuarioPorAuthId(user.id);
  return atualizarConta(usuario.contaId, {
    dataValidade: body.dataVencimento ?? null,
    plano: body.idPlano ?? null,
    status: true,
  });
}

/** POST /adicionar-usuario (configurações → adicionar membro da conta). */
export async function adicionarMembro(body = {}) {
  return criarAuthUser({
    email: body.email,
    password: body.password,
    userMetadata: {
      contaId: texto(body.contaId),
      funcao: texto(body.funcao),
      invite: 'true',
    },
  });
}
