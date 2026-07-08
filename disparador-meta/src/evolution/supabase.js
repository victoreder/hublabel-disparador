import { supabase } from '../supabase.js';

function throwIfError(error, context) {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

export async function fetchDisparosEvolutionJanela(now = new Date()) {
  const fim = new Date(now.getTime() + 60_000);

  const { data, error } = await supabase
    .from('vw_Detalhes_Completo')
    .select('*')
    .eq('Status', 'pending')
    .in('TipoDisparo', ['Individual', 'Grupos'])
    .gte('dataEnvio', now.toISOString())
    .lte('dataEnvio', fim.toISOString());

  throwIfError(error, 'Erro ao buscar disparos Evolution');

  return (data ?? []).filter((row) => {
    const statusDisparo = String(row.StatusDisparo || '');
    return statusDisparo !== 'Pausado' && statusDisparo !== 'Cancelado';
  });
}

export async function fetchContato(idContato) {
  const { data, error } = await supabase
    .from('SAAS_Contatos')
    .select('id, telefone, nome, email, variaveis, contaId, validado, tipo, created_at')
    .eq('id', idContato)
    .maybeSingle();

  throwIfError(error, `Erro ao buscar contato ${idContato}`);
  return data;
}

export async function markSent(id) {
  const { error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({ Status: 'sent' })
    .eq('id', id);

  throwIfError(error, `Erro ao marcar detalhe ${id} como sent`);
}

export async function markFailed(id, { userMessage, statusHttp, respostaHttp }) {
  const { error } = await supabase
    .from('SAAS_Detalhes_Disparos')
    .update({
      Status: 'failed',
      statusHttp: statusHttp != null ? String(statusHttp) : null,
      mensagemErro: userMessage ?? null,
      respostaHttp: respostaHttp ?? null,
    })
    .eq('id', id);

  throwIfError(error, `Erro ao marcar detalhe ${id} como failed`);
}

export async function swapConnection(idDisparo, idConexao) {
  const { error } = await supabase.rpc('swap_connection', {
    p_disparo_id: idDisparo,
    p_blocked_conn_id: idConexao,
  });

  throwIfError(error, `Erro ao trocar conexão do disparo ${idDisparo}`);
}

export async function salvarMensagemNoChat({
  idContato,
  idConexao,
  userId,
  mensagem,
  urlArquivo,
  tipoMensagem,
}) {
  const { error } = await supabase.rpc('f_mensagem_por_contato', {
    p_contato_id: idContato,
    p_id_conexao: idConexao,
    p_conta_id: userId,
    p_mensagem: mensagem ?? null,
    p_url_arquivo: urlArquivo ?? null,
    p_tipo_mensagem: tipoMensagem ?? 'conversation',
  });

  throwIfError(error, 'Erro ao salvar mensagem no chat');
}
