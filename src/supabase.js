import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { config } from './config.js';

/**
 * Chaves novas do Supabase (sb_secret_*) não são JWT.
 * Se forem enviadas em Authorization: Bearer, o PostgREST retorna "Invalid API key".
 * Legacy service_role (eyJ...) continua usando Bearer normalmente.
 */
function createSupabaseFetch() {
  const { supabaseServiceRoleKey: key, supabaseKeyType: keyType } = config;

  return async (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set('apikey', key);

    if (keyType === 'legacy_jwt') {
      headers.set('Authorization', `Bearer ${key}`);
    } else {
      headers.delete('Authorization');
    }

    return fetch(input, { ...init, headers });
  };
}

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    transport: ws,
  },
  global: {
    fetch: createSupabaseFetch(),
  },
});

export function getSupabaseKeyInfo() {
  return {
    keyType: config.supabaseKeyType,
    url: config.supabaseUrl.replace(/^(https:\/\/)([^.]+).*/, '$1$2***'),
  };
}

export async function validateSupabaseConnection() {
  if (config.supabaseKeyType === 'sb_publishable') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY parece ser publishable (sb_publishable_). Use a secret key (sb_secret_) ou a service_role legada (eyJ...).',
    );
  }

  const { error } = await supabase.from('SAAS_Disparos').select('id').limit(1);

  if (!error) return;

  const message = String(error.message).toLowerCase();

  if (message.includes('invalid api key') || message.includes('invalid jwt')) {
    throw new Error(
      'Falha de autenticação no Supabase. Confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY do mesmo projeto. ' +
        'Aceito: service_role legada (eyJ...) ou secret key nova (sb_secret_...).',
    );
  }

  throw new Error(`Falha ao conectar no Supabase: ${error.message}`);
}

function mapSupabaseError(error, context) {
  const message = String(error.message).toLowerCase();

  if (message.includes('invalid api key') || message.includes('invalid jwt')) {
    return new Error(
      `${context}: autenticação Supabase inválida. Verifique URL + service_role (eyJ...) ou sb_secret_...`,
    );
  }

  return new Error(`${context}: ${error.message}`);
}

const INACTIVE_DISPARO = new Set(['pausado', 'cancelado', 'finalizado']);
const AGENDAMENTO_TOLERANCIA_MS = 24 * 60 * 60 * 1000;

/** StatusDisparo e TipoDisparo: comparação case insensitive */
export function isDisparoInactive(statusDisparo) {
  return INACTIVE_DISPARO.has(String(statusDisparo || '').toLowerCase());
}

export function isDisparoApiOficial(tipoDisparo) {
  return String(tipoDisparo || '').toLowerCase() === 'apioficial';
}

export function isDisparoScheduledForFuture(dataAgendamento) {
  if (!dataAgendamento) return false;
  return new Date(dataAgendamento).getTime() > Date.now();
}

/** Ignora se DataAgendamento passou há mais de 1 dia */
export function isDisparoAgendamentoExpirado(dataAgendamento) {
  if (!dataAgendamento) return false;
  return new Date(dataAgendamento).getTime() < Date.now() - AGENDAMENTO_TOLERANCIA_MS;
}

export function isDisparoEligible(disparo) {
  if (!disparo) return false;
  if (!isDisparoApiOficial(disparo.TipoDisparo)) return false;
  if (isDisparoInactive(disparo.StatusDisparo)) return false;
  if (isDisparoScheduledForFuture(disparo.DataAgendamento)) return false;
  if (isDisparoAgendamentoExpirado(disparo.DataAgendamento)) return false;
  return true;
}

export async function fetchActiveDisparoIds() {
  const { data, error } = await supabase
    .from('SAAS_Disparos')
    .select('id, StatusDisparo, TipoDisparo, DataAgendamento');

  if (error) throw mapSupabaseError(error, 'Erro ao buscar disparos ativos');

  return (data ?? []).filter(isDisparoEligible).map((disparo) => disparo.id);
}

export async function fetchPendingDetails(disparoIds, limit = 1) {
  if (!disparoIds.length) return [];

  const { data, error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .select('id, idDisparo, idContato, Mensagem, idConexao, Status, KeyRedis, respostaHttp')
    .eq('Status', 'pending')
    .in('idDisparo', disparoIds)
    .order('id', { ascending: true })
    .limit(limit);

  if (error) throw mapSupabaseError(error, 'Erro ao buscar detalhes pending');
  return data ?? [];
}

export async function fetchDisparo(idDisparo) {
  const { data, error } = await supabase
    .from('SAAS_Disparos')
    .select('id, StatusDisparo, TipoDisparo, DataAgendamento')
    .eq('id', idDisparo)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar disparo ${idDisparo}`);
  return data;
}

export async function claimDetail(detailId) {
  const { data, error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({ Status: 'processing' })
    .eq('id', detailId)
    .eq('Status', 'pending')
    .select('id, idDisparo, idContato, Mensagem, idConexao, Status, KeyRedis, respostaHttp')
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao claim do detalhe ${detailId}`);
  return data;
}

export async function releaseDetail(detailId) {
  const { error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({ Status: 'pending' })
    .eq('id', detailId)
    .eq('Status', 'processing');

  if (error) throw mapSupabaseError(error, `Erro ao liberar detalhe ${detailId}`);
}

export async function fetchConexao(idConexao) {
  const { data, error } = await supabase
    .from('SAAS_Conexões')
    .select('id, apiOficial, access_token, phone_number_id, waba_id, NomeConexao, contaId')
    .eq('id', idConexao)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar conexão ${idConexao}`);
  return data;
}

export async function fetchContato(idContato) {
  const { data, error } = await supabase
    .from('SAAS_Contatos')
    .select('id, telefone, nome, email, variaveis, contaId')
    .eq('id', idContato)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar contato ${idContato}`);
  return data;
}

export async function fetchContatoValoresCampos(idContato) {
  const { data, error } = await supabase
    .from('SAAS_Valores_Campos_Personalizados')
    .select('idCampo, valor')
    .eq('idContato', idContato);

  if (error) throw mapSupabaseError(error, `Erro ao buscar campos do contato ${idContato}`);
  return data ?? [];
}

export async function fetchCamposPersonalizados(contaId) {
  if (!contaId) return [];

  const { data, error } = await supabase
    .from('SAAS_Campos_Personalizados')
    .select('id, nome, tipo')
    .eq('contaId', contaId);

  if (error) throw mapSupabaseError(error, `Erro ao buscar campos personalizados da conta ${contaId}`);
  return data ?? [];
}

export async function fetchTemplateMeta(templateId) {
  const { data, error } = await supabase
    .from('SAAS_Templates_Meta')
    .select('id, nome, idioma, status, conexaoId, componentes, variaveisCampos')
    .eq('id', templateId)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar template ${templateId}`);
  return data;
}

export async function markDetailSent(detailId, { statusHttp, respostaHttp }) {
  const { error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({
      Status: 'sent',
      statusHttp: String(statusHttp),
      mensagemErro: null,
      respostaHttp,
      dataEnvio: new Date().toISOString(),
    })
    .eq('id', detailId);

  if (error) throw mapSupabaseError(error, `Erro ao marcar detalhe ${detailId} como sent`);
}

export async function markDetailFailed(detailId, { statusHttp, mensagemErro, respostaHttp }) {
  const { error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({
      Status: 'failed',
      statusHttp: statusHttp != null ? String(statusHttp) : null,
      mensagemErro,
      respostaHttp: respostaHttp ?? null,
      dataEnvio: new Date().toISOString(),
    })
    .eq('id', detailId);

  if (error) throw mapSupabaseError(error, `Erro ao marcar detalhe ${detailId} como failed`);
}

export async function saveTemplateMessageToChat({
  conexaoId,
  contaId,
  telefone,
  mensagem,
  tipoMensagem,
  metaMessageId,
  arquivoUrl,
  nomeContato,
}) {
  if (!conexaoId || !contaId || !telefone) {
    throw new Error('conexaoId, contaId e telefone são obrigatórios para salvar no chat');
  }

  const { data, error } = await supabase.rpc('f_meta_salvar_mensagem_chat', {
    p_conexao_id: conexaoId,
    p_conta_id: contaId,
    p_telefone: telefone,
    p_mensagem: mensagem ?? null,
    p_tipo_mensagem: tipoMensagem || 'conversation',
    p_from_me: true,
    p_meta_message_id: metaMessageId ?? null,
    p_meta_status: metaMessageId ? 'sent' : null,
    p_arquivo_url: arquivoUrl ?? null,
    p_nome_contato: nomeContato ?? null,
  });

  if (error) throw mapSupabaseError(error, 'Erro ao salvar mensagem de template no chat');

  if (data?.ok === false) {
    throw new Error(data.error || 'f_meta_salvar_mensagem_chat retornou erro');
  }

  return data;
}
