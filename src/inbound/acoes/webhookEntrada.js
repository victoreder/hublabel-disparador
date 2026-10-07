import { sendDispatchEmail } from '../../email/smtp.js';
import { logger } from '../../logger.js';
import { supabase } from '../../supabase.js';
import {
  AuthAdminError,
  atualizarConta,
  buscarUsuarioPorAuthId,
  buscarUsuarioPorEmail,
  criarAuthUser,
  hojeMaisDias,
} from './usuarios.js';

/**
 * Webhooks de entrada configurados pelo cliente:
 *  - POST /token?id=...      → leads (SAAS_Webhook)
 *  - POST /integracao?id=... → gateway de pagamento (SAAS_IntegracaoPagamento)
 * Em modo teste só guardam o payload (para a tela de mapeamento); ativos
 * processam o payload conforme o mapeamento salvo.
 */

const WEBHOOK_META_ETIQUETAS = '_idEtiquetas';
const WEBHOOK_CAMPO_PREFIX = 'cp_';
const SENHA_PADRAO_INTEGRACAO = process.env.SENHA_PADRAO_INTEGRACAO?.trim() || 'Padrao123456';

function normalizePath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (s.startsWith('$.')) s = s.slice(2);
  if (s.startsWith('$')) s = s.slice(1);
  if (s.startsWith('.')) s = s.slice(1);
  return s.length ? s : null;
}

function tokenize(path) {
  const tokens = [];
  const re = /[^.[\]"']+|\[(\d+)\]|\["([^"]+)"\]|\['([^']+)'\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[0][0] !== '[') tokens.push(m[0]);
    else if (m[1] !== undefined) tokens.push(Number(m[1]));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else if (m[3] !== undefined) tokens.push(m[3]);
  }
  return tokens;
}

export function getByPath(obj, rawPath) {
  const p = normalizePath(rawPath);
  if (!p) return undefined;
  let cur = obj;
  for (const t of tokenize(p)) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

/** Valor do mapeamento: um path ou uma lista de paths (primeiro preenchido). */
export function extract(payload, mappingValue) {
  if (Array.isArray(mappingValue)) {
    for (const p of mappingValue) {
      const v = getByPath(payload, p);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }
  return getByPath(payload, mappingValue);
}

function valorParaTexto(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 'sim' : 'nao';
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Nó "CAMPOS MAPEADOS" do /token: nome, telefone, campos [{idCampo, valor}] e etiquetas. */
export function mapearCamposLead(payload, mapeamento) {
  const result = { nome: null, telefone: null, campos: [], idEtiquetas: [] };

  for (const [campoDestino, pathOuLista] of Object.entries(mapeamento ?? {})) {
    if (campoDestino === WEBHOOK_META_ETIQUETAS) {
      const ids = Array.isArray(pathOuLista) ? pathOuLista : [];
      result.idEtiquetas = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      continue;
    }

    const valor = extract(payload, pathOuLista);
    if (campoDestino === 'nome') {
      result.nome = valorParaTexto(valor);
    } else if (campoDestino === 'telefone') {
      result.telefone = valorParaTexto(valor);
    } else if (campoDestino.startsWith(WEBHOOK_CAMPO_PREFIX)) {
      const idCampo = Number(campoDestino.slice(WEBHOOK_CAMPO_PREFIX.length));
      const valorTexto = valorParaTexto(valor);
      if (Number.isFinite(idCampo) && valorTexto !== null) result.campos.push({ idCampo, valor: valorTexto });
    }
  }
  return result;
}

function getByDotPath(obj, path) {
  return String(path)
    .trim()
    .split('.')
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

/** Substitui [nome], [telefone], [cp_ID] (e [campo_ID]) na mensagem padrão. */
export function montarMensagemLead(template, dados) {
  const vars = {};
  if (dados.nome != null && dados.nome !== '') vars.nome = String(dados.nome);
  if (dados.telefone != null && dados.telefone !== '') vars.telefone = String(dados.telefone);
  for (const c of dados.campos ?? []) {
    if (c?.idCampo == null || c.valor == null || String(c.valor).trim() === '') continue;
    vars[`cp_${c.idCampo}`] = String(c.valor);
    vars[`campo_${c.idCampo}`] = String(c.valor);
    if (c.nome) vars[String(c.nome).trim()] = String(c.valor);
  }

  return String(template ?? '').replace(/\[\s*([^\]]+?)\s*\]/g, (_, key) => {
    const value = getByDotPath(vars, key.trim());
    return value === undefined || value === null ? '' : String(value);
  });
}

async function buscarConfigPorToken(table, token) {
  if (!token) return null;
  const { data, error } = await supabase.from(table).select('*').eq('tokenWebhook', token).limit(1);
  if (error) throw new Error(`Erro ao buscar ${table}: ${error.message}`);
  return data?.[0] ?? null;
}

async function salvarUltimoPayload(table, token, payload) {
  const { error } = await supabase.from(table).update({ ultimoPayload: payload }).eq('tokenWebhook', token);
  if (error) throw new Error(`Erro ao salvar ultimoPayload em ${table}: ${error.message}`);
}

async function enviarTextoEvolution({ evolutionBaseUrl, conexao, numero, texto }) {
  const res = await fetch(
    `${evolutionBaseUrl}/message/sendText/${encodeURIComponent(conexao.instanceName)}`,
    {
      method: 'POST',
      headers: { apikey: conexao.Apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: numero, text: texto, delay: 1000 }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Evolution ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
  return json;
}

/** POST /token — chamado em segundo plano (a resposta HTTP já foi enviada). */
export async function processarWebhookLead({ token, payload, evolutionBaseUrl }) {
  const config = await buscarConfigPorToken('SAAS_Webhook', token);
  if (!config) {
    logger.warn('[webhook-token] token não encontrado', { token });
    return { status: 'nao_encontrado' };
  }

  if (config.teste === true) {
    await salvarUltimoPayload('SAAS_Webhook', token, payload);
    return { status: 'payload_teste_salvo' };
  }
  if (config.status !== true) return { status: 'inativo' };

  const dados = mapearCamposLead(payload, config.mapeamento);
  const mensagem = montarMensagemLead(config.mensagemPadrao || '', dados);

  const { error: syncError } = await supabase.rpc('f_hub_webhook_sincronizar_contato', {
    p_conta_id: config.contaId,
    p_telefone: dados.telefone,
    p_nome: dados.nome,
    p_campos: dados.campos,
    p_etiquetas: dados.idEtiquetas,
  });
  if (syncError) throw new Error(`f_webhook_sincronizar_contato: ${syncError.message}`);

  const { data: conexao, error: conexaoError } = await supabase
    .from('SAAS_Conexões')
    .select('*')
    .eq('id', config.conexaoId)
    .maybeSingle();
  if (conexaoError) throw new Error(`Erro ao buscar conexão: ${conexaoError.message}`);
  if (!conexao) return { status: 'sem_conexao' };

  // Como no n8n: falha no envio não derruba o contato já sincronizado.
  let envio;
  try {
    envio = await enviarTextoEvolution({ evolutionBaseUrl, conexao, numero: dados.telefone, texto: mensagem });
  } catch (error) {
    logger.warn('[webhook-token] falha ao enviar mensagem padrão', { token, message: error.message });
    return { status: 'contato_salvo_envio_falhou' };
  }

  const remoteJid = envio?.key?.remoteJid;
  if (!remoteJid) return { status: 'enviado_sem_key' };

  const { error: convError } = await supabase.rpc('f_hub_conversa_ou_mensagem', {
    p_telefone: remoteJid,
    p_id_conexao: conexao.id,
    p_user_id: conexao.idUsuario,
    p_mensagem: mensagem,
    p_message_id: envio?.key?.id ?? null,
    p_id_agente: config.idAgente ?? null,
  });
  if (convError) throw new Error(`f_conversa_ou_mensagem: ${convError.message}`);
  return { status: 'enviado' };
}

/** Nó "CAMPOS MAPEADOS1": { campoDestino: valor } para cada item do mapeamento. */
export function mapearCamposPagamento(payload, mapeamento) {
  const result = {};
  for (const [campoDestino, pathOuLista] of Object.entries(mapeamento ?? {})) {
    result[campoDestino] = extract(payload, pathOuLista);
  }
  return result;
}

async function buscarPlano({ nome, planoIdPadrao }) {
  if (nome != null && String(nome).trim() !== '') {
    const { data, error } = await supabase.from('SAAS_Planos').select('*').eq('nome', nome).limit(1);
    if (error) throw new Error(`Erro ao buscar SAAS_Planos: ${error.message}`);
    if (data?.[0]) return data[0];
  }
  if (planoIdPadrao == null) return null;
  const { data, error } = await supabase.from('SAAS_Planos').select('*').eq('id', planoIdPadrao).maybeSingle();
  if (error) throw new Error(`Erro ao buscar SAAS_Planos: ${error.message}`);
  return data;
}

/** POST /integracao — compra aprovada: cria (ou renova) o usuário e manda o e-mail de boas-vindas. */
export async function processarIntegracaoPagamento({ token, payload }) {
  const config = await buscarConfigPorToken('SAAS_IntegracaoPagamento', token);
  if (!config) {
    logger.warn('[integracao] token não encontrado', { token });
    return { status: 'nao_encontrado' };
  }

  if (config.teste === true) {
    await salvarUltimoPayload('SAAS_IntegracaoPagamento', token, payload);
    return { status: 'payload_teste_salvo' };
  }
  if (config.status !== true) return { status: 'inativo' };

  const vars = mapearCamposPagamento(payload, config.mapeamento);
  const email = String(vars.email ?? '').trim();
  if (!email) throw new Error('Integração sem e-mail mapeado no payload');

  const plano = await buscarPlano({ nome: vars.plano, planoIdPadrao: config.planoId });
  const contaFields = {
    dataValidade: hojeMaisDias(plano?.diasValidade ?? 0),
    plano: plano?.id ?? config.planoId ?? null,
    status: true,
  };

  let usuario;
  let novoUsuario = true;
  try {
    const user = await criarAuthUser({
      email,
      password: SENHA_PADRAO_INTEGRACAO,
      userMetadata: { nome: String(vars.nome ?? ''), telefone: String(vars.telefone ?? '') },
    });
    usuario = await buscarUsuarioPorAuthId(user.id);
  } catch (error) {
    if (!(error instanceof AuthAdminError)) throw error;
    // E-mail já cadastrado (renovação): libera a conta existente.
    novoUsuario = false;
    usuario = await buscarUsuarioPorEmail(email);
    if (!usuario) throw new Error(`Não foi possível criar nem achar o usuário ${email}: ${error.message}`);
  }

  await atualizarConta(usuario.contaId, contaFields);

  const { data: cfgEmail } = await supabase
    .from('SAAS_Config_Emails')
    .select(
      'smtp_email, smtp_name, smtp_host, smtp_port, smtp_user, smtp_apikey, assunto_email_novousuario, html_email_novousuario',
    )
    .eq('id', 1)
    .maybeSingle();
  try {
    await sendDispatchEmail({
      remetente: { id: 'config-emails', ...cfgEmail },
      to: email,
      subject: cfgEmail?.assunto_email_novousuario,
      html: cfgEmail?.html_email_novousuario,
    });
  } catch (error) {
    logger.warn('[integracao] conta liberada, mas e-mail de boas-vindas falhou', {
      email,
      message: error.message,
    });
  }

  return { status: novoUsuario ? 'usuario_criado' : 'conta_renovada', contaId: usuario.contaId };
}
