import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const INACTIVE_DISPARO = new Set(['pausado', 'cancelado']);

export function isDisparoInactive(statusDisparo) {
  return INACTIVE_DISPARO.has(String(statusDisparo || '').toLowerCase());
}

export function isDisparoScheduledForFuture(dataAgendamento) {
  if (!dataAgendamento) return false;
  return new Date(dataAgendamento).getTime() > Date.now();
}

export async function fetchActiveDisparoIds() {
  const { data, error } = await supabase
    .from('SAAS_Disparos')
    .select('id, StatusDisparo, DataAgendamento');

  if (error) throw new Error(`Erro ao buscar disparos ativos: ${error.message}`);

  return (data ?? [])
    .filter(
      (disparo) =>
        !isDisparoInactive(disparo.StatusDisparo) &&
        !isDisparoScheduledForFuture(disparo.DataAgendamento),
    )
    .map((disparo) => disparo.id);
}

export async function fetchPendingDetails(disparoIds, limit = 1) {
  if (!disparoIds.length) return [];

  const { data, error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .select('id, idDisparo, idContato, Mensagem, idConexao, Status, Payload, KeyRedis')
    .eq('Status', 'pending')
    .in('idDisparo', disparoIds)
    .order('id', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Erro ao buscar detalhes pending: ${error.message}`);
  return data ?? [];
}

export async function fetchDisparo(idDisparo) {
  const { data, error } = await supabase
    .from('SAAS_Disparos')
    .select('id, StatusDisparo, DataAgendamento')
    .eq('id', idDisparo)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar disparo ${idDisparo}: ${error.message}`);
  return data;
}

export async function claimDetail(detailId) {
  const { data, error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({ Status: 'processing' })
    .eq('id', detailId)
    .eq('Status', 'pending')
    .select('id, idDisparo, idContato, Mensagem, idConexao, Status, Payload, KeyRedis')
    .maybeSingle();

  if (error) throw new Error(`Erro ao claim do detalhe ${detailId}: ${error.message}`);
  return data;
}

export async function releaseDetail(detailId) {
  const { error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({ Status: 'pending' })
    .eq('id', detailId)
    .eq('Status', 'processing');

  if (error) throw new Error(`Erro ao liberar detalhe ${detailId}: ${error.message}`);
}

export async function fetchConexao(idConexao) {
  const { data, error } = await supabase
    .from('SAAS_Conexões')
    .select('id, apiOficial, access_token, phone_number_id, waba_id, NomeConexao')
    .eq('id', idConexao)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar conexão ${idConexao}: ${error.message}`);
  return data;
}

export async function fetchContato(idContato) {
  const { data, error } = await supabase
    .from('SAAS_Contatos')
    .select('id, telefone, nome')
    .eq('id', idContato)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar contato ${idContato}: ${error.message}`);
  return data;
}

export async function fetchTemplateMeta(templateId) {
  const { data, error } = await supabase
    .from('SAAS_Templates_Meta')
    .select('id, nome, idioma, status, conexaoId')
    .eq('id', templateId)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar template ${templateId}: ${error.message}`);
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

  if (error) throw new Error(`Erro ao marcar detalhe ${detailId} como sent: ${error.message}`);
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

  if (error) throw new Error(`Erro ao marcar detalhe ${detailId} como failed: ${error.message}`);
}
