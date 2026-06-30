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

export async function fetchConfigApiOficial() {
  const { data, error } = await supabase
    .from('SAAS_Config_ApiOficial')
    .select('verifyToken')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, 'Erro ao buscar SAAS_Config_ApiOficial');
  return data;
}

export async function fetchConfigIA() {
  const { data, error } = await supabase
    .from('SAAS_Config_IA')
    .select('tipoIA, apikey')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, 'Erro ao buscar SAAS_Config_IA');
  return data;
}

export async function fetchConfigEmails() {
  const { data, error } = await supabase
    .from('SAAS_Config_Emails')
    .select('smtp_email, smtp_name, smtp_host, smtp_port, smtp_user, smtp_apikey')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, 'Erro ao buscar SAAS_Config_Emails');
  return data;
}

export async function processMetaEvent(evento) {
  const { data, error } = await supabase.rpc('f_meta_processar_evento', {
    p_evento: evento,
  });

  if (error) throw mapSupabaseError(error, 'Erro em f_meta_processar_evento');
  return data;
}

export async function fetchConexaoForMedia(phoneNumberId, wabaId) {
  if (phoneNumberId) {
    const { data, error } = await supabase
      .from('SAAS_Conexões')
      .select('id, contaId, access_token')
      .eq('apiOficial', true)
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();

    if (error) throw mapSupabaseError(error, 'Erro ao buscar conexão por phone_number_id');
    if (data) return data;
  }

  if (wabaId) {
    const { data, error } = await supabase
      .from('SAAS_Conexões')
      .select('id, contaId, access_token')
      .eq('apiOficial', true)
      .eq('waba_id', wabaId)
      .limit(1);

    if (error) throw mapSupabaseError(error, 'Erro ao buscar conexão por waba_id');
    return data?.[0] ?? null;
  }

  return null;
}

export async function saveMetaMediaJob({
  conexaoId,
  contaId,
  telefone,
  mensagem,
  tipo_mensagem,
  meta_message_id,
  link,
  nome_contato,
  mensagemRespondida,
}) {
  const { data, error } = await supabase.rpc('f_meta_salvar_mensagem_midia_job', {
    p_job: {
      conexaoId,
      contaId,
      telefone,
      mensagem,
      tipo_mensagem,
      meta_message_id,
      link,
      nome_contato: nome_contato,
      mensagemRespondida: mensagemRespondida ?? null,
    },
  });

  if (error) throw mapSupabaseError(error, 'Erro em f_meta_salvar_mensagem_midia_job');

  if (data?.ok === false) {
    throw new Error(data.error || 'f_meta_salvar_mensagem_midia_job retornou erro');
  }

  return data;
}

export async function fetchConexaoById(idConexao) {
  const { data, error } = await supabase
    .from('SAAS_Conexões')
    .select('id, contaId, apiOficial, access_token, phone_number_id, NomeConexao, idAgente, instanceName, Apikey')
    .eq('id', idConexao)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar conexão ${idConexao}`);
  return data;
}

export async function fetchEvolutionConexaoDaConta(contaId) {
  if (!contaId) return null;

  const { data, error } = await supabase
    .from('SAAS_Conexões')
    .select('id, instanceName, Apikey')
    .eq('contaId', contaId)
    .eq('apiOficial', false)
    .not('instanceName', 'is', null)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, 'Erro ao buscar conexão Evolution da conta');
  return data;
}

export async function fetchContatoFotoPerfil(contatoId) {
  const { data, error } = await supabase
    .from('SAAS_Contatos')
    .select('fotoPerfil')
    .eq('id', contatoId)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar fotoPerfil do contato ${contatoId}`);
  return data?.fotoPerfil ?? null;
}

export async function atualizarContatoFotoPerfil(contatoId, fotoPerfil) {
  const { error } = await supabase
    .from('SAAS_Contatos')
    .update({ fotoPerfil })
    .eq('id', contatoId);

  if (error) throw mapSupabaseError(error, `Erro ao atualizar fotoPerfil do contato ${contatoId}`);
}

export async function ingestaoMensagem(payload) {
  const { data, error } = await supabase.rpc('f_ingestao_mensagem', {
    p_input: payload,
  });

  if (error) throw mapSupabaseError(error, 'Erro em f_ingestao_mensagem');
  return data;
}

export async function fetchAgente(idAgente) {
  const { data, error } = await supabase
    .from('SAAS_AgentesIA')
    .select('*')
    .eq('id', idAgente)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar agente ${idAgente}`);
  return data;
}

export async function addTokensUsuarioPorAgente(params) {
  const { data, error } = await supabase.rpc('f_add_tokens_usuario_por_agente', {
    p_params: params,
  });

  if (error) throw mapSupabaseError(error, 'Erro em f_add_tokens_usuario_por_agente');
  return data;
}

export async function saveMensagemIA({
  contaId,
  conexaoId,
  conversaId,
  mensagem,
  tipoMensagem,
  arquivoUrl,
  messageEvolutionId,
}) {
  const { error } = await supabase.from('SAAS_Mensagens').insert({
    contaId,
    conexaoId,
    conversaId,
    mensagem,
    tipoMensagem: tipoMensagem || 'conversation',
    arquivoUrl: arquivoUrl ?? null,
    fromMe: true,
    enviada: true,
    IA: true,
    messageEvolutionId: messageEvolutionId ?? null,
  });

  if (error) throw mapSupabaseError(error, 'Erro ao salvar mensagem IA');
}

export async function updateConversaUltimaMensagem({ telefone, conexaoId, agenteId }) {
  const { error } = await supabase
    .from('SAAS_Conversas_Agentes')
    .update({
      ultimaMensagem: new Date().toISOString(),
      idAgente: agenteId ?? undefined,
    })
    .eq('telefone', telefone)
    .eq('idConexao', conexaoId);

  if (error) throw mapSupabaseError(error, 'Erro ao atualizar conversa do agente');
}

export async function abrirAtendimentoHumano({ telefone, conexaoId }) {
  const { error } = await supabase
    .from('SAAS_Conversas_Agentes')
    .update({
      statusAtendimento: 'aberto',
      pausado: true,
    })
    .eq('telefone', telefone)
    .eq('idConexao', conexaoId);

  if (error) throw mapSupabaseError(error, 'Erro ao abrir atendimento humano');
}

export async function fetchConversaAgente(conversaId) {
  const { data, error } = await supabase
    .from('SAAS_Conversas_Agentes')
    .select('id, idAgente, atendente, setorId, pausado, statusAtendimento, contatoId')
    .eq('id', conversaId)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, `Erro ao buscar conversa ${conversaId}`);
  return data;
}

export async function buscarAtendenteAleatorio(contaId) {
  if (!contaId) return null;

  const { data, error } = await supabase
    .from('SAAS_Usuarios')
    .select('id')
    .eq('contaId', contaId);

  if (error) throw mapSupabaseError(error, 'Erro ao buscar atendentes da conta');
  if (!data?.length) return null;

  return data[Math.floor(Math.random() * data.length)].id;
}

export async function buscarAtendenteAleatorioSetor(setorId, contaId) {
  if (!setorId) return buscarAtendenteAleatorio(contaId);

  const { data, error } = await supabase
    .from('SAAS_Setores_Usuarios')
    .select('usuarioId')
    .eq('setorId', setorId);

  if (error) throw mapSupabaseError(error, 'Erro ao buscar membros do setor');
  if (!data?.length) return null;

  return data[Math.floor(Math.random() * data.length)].usuarioId;
}

export async function transferirConversaHumano({ conversaId, atendenteId, pausado = true, statusAtendimento = 'aberto' }) {
  const update = {
    atendente: atendenteId ?? null,
    pausado,
    statusAtendimento,
  };

  const { error } = await supabase.from('SAAS_Conversas_Agentes').update(update).eq('id', conversaId);
  if (error) throw mapSupabaseError(error, 'Erro ao transferir conversa para atendente');
}

export async function transferirConversaSetor({ conversaId, setorId, atendenteId, pausado, statusAtendimento }) {
  const update = {
    setorId,
    atendente: atendenteId ?? null,
  };

  if (pausado != null) update.pausado = pausado;
  if (statusAtendimento) update.statusAtendimento = statusAtendimento;

  const { error } = await supabase.from('SAAS_Conversas_Agentes').update(update).eq('id', conversaId);
  if (error) throw mapSupabaseError(error, 'Erro ao transferir conversa para setor');
}

export async function transferirConversaAgenteIA({ conversaId, agenteId }) {
  const { error } = await supabase
    .from('SAAS_Conversas_Agentes')
    .update({ idAgente: agenteId })
    .eq('id', conversaId);

  if (error) throw mapSupabaseError(error, 'Erro ao transferir conversa para agente IA');
}

export async function atualizarConversaAgente({ conversaId, patch }) {
  const { error } = await supabase.from('SAAS_Conversas_Agentes').update(patch).eq('id', conversaId);
  if (error) throw mapSupabaseError(error, 'Erro ao atualizar conversa');
}

export async function adicionarEtiquetaContato({ contatoId, etiquetaId, contaId }) {
  const { error } = await supabase.from('SAAS_Contatos_Etiquetas').insert({
    contatoId,
    etiquetaId,
    contaId,
  });

  if (error && error.code !== '23505') {
    throw mapSupabaseError(error, 'Erro ao adicionar etiqueta');
  }
}

export async function removerEtiquetaContato({ contatoId, etiquetaId }) {
  const { error } = await supabase
    .from('SAAS_Contatos_Etiquetas')
    .delete()
    .eq('contatoId', contatoId)
    .eq('etiquetaId', etiquetaId);

  if (error) throw mapSupabaseError(error, 'Erro ao remover etiqueta');
}

export async function atualizarCampoPersonalizado({ contatoId, campoId, contaId, valor }) {
  const { error } = await supabase.from('SAAS_Valores_Campos_Personalizados').upsert(
    { idContato: contatoId, idCampo: campoId, contaId, valor },
    { onConflict: 'idContato,idCampo' },
  );

  if (error) throw mapSupabaseError(error, 'Erro ao salvar campo personalizado');
}

export async function buscarCardContato({ contatoId, quadroId = null }) {
  let query = supabase
    .from('SAAS_Cards_Quadros')
    .select('id, quadroId, etapaQuadroId, observacoes, valor, tarefas')
    .eq('contatoId', contatoId)
    .order('id', { ascending: false })
    .limit(1);

  if (quadroId) query = query.eq('quadroId', quadroId);

  const { data, error } = await query.maybeSingle();
  if (error) throw mapSupabaseError(error, 'Erro ao buscar card CRM');
  return data;
}

export async function criarCardCrm({ contatoId, quadroId, etapaId, nome, contato }) {
  const { data, error } = await supabase
    .from('SAAS_Cards_Quadros')
    .insert({
      quadroId,
      contatoId,
      etapaQuadroId: etapaId,
      nome: nome ?? null,
      contato: contato ?? null,
    })
    .select('id, quadroId, etapaQuadroId, observacoes, valor, tarefas')
    .single();

  if (error) throw mapSupabaseError(error, 'Erro ao criar card CRM');
  return data;
}

export async function moverCardCrm({ cardId, etapaId, quadroId }) {
  const { data: card, error: fetchError } = await supabase
    .from('SAAS_Cards_Quadros')
    .select('historicoCRM, etapaQuadroId, quadroId')
    .eq('id', cardId)
    .maybeSingle();

  if (fetchError) throw mapSupabaseError(fetchError, 'Erro ao buscar card para mover');

  const historico = Array.isArray(card?.historicoCRM) ? card.historicoCRM : [];
  historico.push({
    tipo: 'movimentacao',
    de: card?.etapaQuadroId ?? null,
    para: etapaId,
    em: new Date().toISOString(),
    origem: 'agenteIA',
  });

  const { error } = await supabase
    .from('SAAS_Cards_Quadros')
    .update({
      etapaQuadroId: etapaId,
      quadroId: quadroId ?? card?.quadroId,
      historicoCRM: historico,
    })
    .eq('id', cardId);

  if (error) throw mapSupabaseError(error, 'Erro ao mover card CRM');
}

export async function preencherCardCrm({ cardId, observacoes, valor, criarTarefa, textoTarefa, prazoTarefa }) {
  const { data: card, error: fetchError } = await supabase
    .from('SAAS_Cards_Quadros')
    .select('observacoes, valor, tarefas')
    .eq('id', cardId)
    .maybeSingle();

  if (fetchError) throw mapSupabaseError(fetchError, 'Erro ao buscar card para preencher');

  const update = {};

  if (observacoes) {
    const atual = String(card?.observacoes || '').trim();
    update.observacoes = atual ? `${atual}\n\n${observacoes}` : observacoes;
  }

  if (valor != null && valor !== '' && Number.isFinite(Number(valor))) {
    update.valor = Number(valor);
  }

  if (criarTarefa) {
    const tarefas = Array.isArray(card?.tarefas) ? [...card.tarefas] : [];
    tarefas.push({
      texto: textoTarefa || 'Tarefa criada pelo agente IA',
      prazo: prazoTarefa || null,
      concluida: false,
      criadaEm: new Date().toISOString(),
      origem: 'agenteIA',
    });
    update.tarefas = tarefas;
  }

  if (!Object.keys(update).length) return;

  const { error } = await supabase.from('SAAS_Cards_Quadros').update(update).eq('id', cardId);
  if (error) throw mapSupabaseError(error, 'Erro ao preencher card CRM');
}

export async function notificarHumanoWhatsapp({ job, whatsappDestino, mensagem }) {
  const { serverUrl, instance, apikey, apiOficial, accessToken, phoneNumberId } = job.envio ?? {};

  if (apiOficial) {
    const to = String(whatsappDestino).replace(/\D/g, '');
    const response = await fetch(
      `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v25.0'}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: mensagem },
        }),
      },
    );
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) {
      throw new Error(json.error?.message || 'Falha ao notificar humano via Meta');
    }
    return;
  }

  if (!serverUrl || !instance || !apikey) {
    throw new Error('Dados Evolution ausentes para notificar humano');
  }

  const baseUrl = serverUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: whatsappDestino, text: mensagem }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(json?.message || 'Falha ao notificar humano via Evolution');
  }
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
