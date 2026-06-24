import { supabase } from '../supabase.js';
import { logger } from '../logger.js';
import { phonesMatch } from './phoneVariants.js';

function throwIfError(error, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function isDuplicateError(error) {
  if (!error) return false;
  if (error.code === '23505') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('duplicad') || msg.includes('duplicate') || msg.includes('unique');
}

async function pickKeepAndRemove(contatoId, otherId) {
  const ids = [contatoId, otherId];
  const { data, error } = await supabase
    .from('SAAS_Contatos')
    .select('id, created_at')
    .in('id', ids);

  throwIfError(error, 'Erro ao buscar contatos para mesclagem');

  const sorted = (data ?? []).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  if (sorted.length < 2) {
    return { keepId: contatoId, removeId: otherId };
  }

  return { keepId: sorted[0].id, removeId: sorted[1].id };
}

async function mergeEtiquetas(keepId, removeId, contaId) {
  const { data: tags, error } = await supabase
    .from('SAAS_Contatos_Etiquetas')
    .select('etiquetaId')
    .eq('contatoId', removeId);

  throwIfError(error, 'Erro ao buscar etiquetas do contato removido');

  for (const row of tags ?? []) {
    const { data: existing } = await supabase
      .from('SAAS_Contatos_Etiquetas')
      .select('contatoId')
      .eq('contatoId', keepId)
      .eq('etiquetaId', row.etiquetaId)
      .maybeSingle();

    if (!existing) {
      const { error: insErr } = await supabase.from('SAAS_Contatos_Etiquetas').insert({
        contatoId: keepId,
        etiquetaId: row.etiquetaId,
        contaId,
      });
      if (insErr && !isDuplicateError(insErr)) throwIfError(insErr, 'Erro ao mover etiqueta');
    }
  }

  const { error: delErr } = await supabase
    .from('SAAS_Contatos_Etiquetas')
    .delete()
    .eq('contatoId', removeId);

  throwIfError(delErr, 'Erro ao remover etiquetas do contato duplicado');
}

async function mergeCamposPersonalizados(keepId, removeId, contaId) {
  const { data: valores, error } = await supabase
    .from('SAAS_Valores_Campos_Personalizados')
    .select('id, idCampo, valor')
    .eq('idContato', removeId);

  throwIfError(error, 'Erro ao buscar campos personalizados do contato removido');

  for (const row of valores ?? []) {
    const { data: existing } = await supabase
      .from('SAAS_Valores_Campos_Personalizados')
      .select('id')
      .eq('idContato', keepId)
      .eq('idCampo', row.idCampo)
      .maybeSingle();

    if (!existing) {
      const { error: insErr } = await supabase.from('SAAS_Valores_Campos_Personalizados').insert({
        idCampo: row.idCampo,
        idContato: keepId,
        contaId,
        valor: row.valor,
      });
      if (insErr && !isDuplicateError(insErr)) throwIfError(insErr, 'Erro ao mover campo personalizado');
    }
  }

  const { error: delErr } = await supabase
    .from('SAAS_Valores_Campos_Personalizados')
    .delete()
    .eq('idContato', removeId);

  throwIfError(delErr, 'Erro ao remover campos do contato duplicado');
}

async function mergeConversas(keepId, removeId, jid) {
  const { error } = await supabase
    .from('SAAS_Conversas_Agentes')
    .update({ contatoId: keepId, telefone: jid })
    .eq('contatoId', removeId);

  throwIfError(error, 'Erro ao mover conversas do contato duplicado');
}

async function mergeCards(keepId, removeId) {
  const { error } = await supabase
    .from('SAAS_Cards_Quadros')
    .update({ contatoId: keepId })
    .eq('contatoId', removeId);

  throwIfError(error, 'Erro ao mover cards do contato duplicado');
}

export async function mergeContatosDuplicados({ keepId, removeId, contaId, jid }) {
  await mergeEtiquetas(keepId, removeId, contaId);
  await mergeCamposPersonalizados(keepId, removeId, contaId);
  await mergeConversas(keepId, removeId, jid);
  await mergeCards(keepId, removeId);

  const { error: updErr } = await supabase
    .from('SAAS_Contatos')
    .update({ telefone: jid, validado: true })
    .eq('id', keepId);

  throwIfError(updErr, 'Erro ao atualizar contato mantido após mesclagem');

  const { error: delErr } = await supabase.from('SAAS_Contatos').delete().eq('id', removeId);

  throwIfError(delErr, 'Erro ao excluir contato duplicado');

  logger.info('Contatos mesclados após validação', { keepId, removeId, jid });
  return keepId;
}

export async function findExistingContactByPhone(contaId, jid, excludeId) {
  const { data, error } = await supabase
    .from('SAAS_Contatos')
    .select('id, telefone, created_at, validado')
    .eq('contaId', contaId)
    .eq('tipo', 'contato')
    .neq('id', excludeId);

  throwIfError(error, 'Erro ao buscar contato duplicado por telefone');

  return (data ?? []).find((row) => phonesMatch(row.telefone, jid)) ?? null;
}

export async function persistValidatedContactPhone({ contatoId, contaId, jid }) {
  const existing = await findExistingContactByPhone(contaId, jid, contatoId);

  if (existing) {
    const { keepId, removeId } = await pickKeepAndRemove(contatoId, existing.id);
    const finalId = await mergeContatosDuplicados({ keepId, removeId, contaId, jid });
    return { idContato: finalId, jid };
  }

  const { error } = await supabase
    .from('SAAS_Contatos')
    .update({ telefone: jid, validado: true })
    .eq('id', contatoId);

  if (error && isDuplicateError(error)) {
    const dup = await findExistingContactByPhone(contaId, jid, contatoId);
    if (dup) {
      const { keepId, removeId } = await pickKeepAndRemove(contatoId, dup.id);
      const finalId = await mergeContatosDuplicados({ keepId, removeId, contaId, jid });
      return { idContato: finalId, jid };
    }
  }

  throwIfError(error, 'Erro ao persistir telefone validado');

  await supabase
    .from('SAAS_Conversas_Agentes')
    .update({ telefone: jid })
    .eq('contatoId', contatoId);

  return { idContato: contatoId, jid };
}
