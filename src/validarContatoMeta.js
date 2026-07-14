import { logger } from './logger.js';
import { checkWhatsAppContacts, MetaApiError } from './meta.js';
import { formatPhoneForLog, normalizePhone } from './phone.js';
import { getValidationNumberCandidates } from './evolution/phoneVariants.js';
import { updateContatoValidadoKeepId } from './evolution/mergeContatos.js';

const MSG_INEXISTENTE = 'Contato inexistente';

function pickValidWhatsAppContact(results, candidates) {
  if (!Array.isArray(results)) return null;

  const candidateDigits = candidates.map((c) => normalizePhone(c)).filter(Boolean);

  for (const candidate of candidateDigits) {
    const match = results.find((row) => {
      if (String(row?.status || '').toLowerCase() !== 'valid') return false;
      const waId = normalizePhone(row?.wa_id);
      const input = normalizePhone(row?.input);
      return Boolean(waId) && (waId === candidate || input === candidate);
    });
    if (match?.wa_id) return match;
  }

  return (
    results.find(
      (row) => String(row?.status || '').toLowerCase() === 'valid' && normalizePhone(row?.wa_id),
    ) ?? null
  );
}

/**
 * Valida na Meta e ATUALIZA o mesmo contato do disparo (nunca cria outro).
 */
export async function ensureContactValidatedForMetaDispatch({
  contato,
  conexao,
  detailId,
}) {
  if (!contato?.id) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  if (contato.validado === true && contato.telefone) {
    const phone = normalizePhone(contato.telefone);
    if (!phone) return { ok: false, reason: MSG_INEXISTENTE };
    return { ok: true, phone, idContato: contato.id, skipped: true };
  }

  if (!conexao?.phone_number_id || !conexao?.access_token) {
    logger.warn('Conexão sem credenciais Meta para validar contato', { detailId });
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  const candidates = getValidationNumberCandidates(contato.telefone);
  if (!candidates.length) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  let results;
  try {
    results = await checkWhatsAppContacts({
      phoneNumberId: conexao.phone_number_id,
      accessToken: conexao.access_token,
      phones: candidates,
    });
  } catch (err) {
    logger.warn('Falha na API Meta /contacts', {
      detailId,
      contatoId: contato.id,
      message: err instanceof Error ? err.message : String(err),
      status: err instanceof MetaApiError ? err.status : null,
      body: err instanceof MetaApiError ? err.body : null,
    });
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  const valid = pickValidWhatsAppContact(results, candidates);
  const waId = normalizePhone(valid?.wa_id);
  if (!waId) {
    logger.info('Contato sem WhatsApp na verificação Meta', {
      detailId,
      contatoId: contato.id,
      candidatos: candidates.map(formatPhoneForLog),
      resultados: results,
    });
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  const contaId = contato.contaId || conexao.contaId;
  if (!contaId) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  try {
    // Mantém o id do contato do disparo; só atualiza telefone + validado.
    const persisted = await updateContatoValidadoKeepId({
      contatoId: contato.id,
      contaId,
      telefone: waId,
    });

    logger.info('Contato atualizado como validado via Meta /contacts', {
      detailId,
      contatoId: persisted.idContato,
      telefone: formatPhoneForLog(waId),
    });

    return {
      ok: true,
      phone: waId,
      idContato: persisted.idContato,
      skipped: false,
    };
  } catch (err) {
    logger.error('Erro ao atualizar contato validado (Meta)', {
      detailId,
      contatoId: contato.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: MSG_INEXISTENTE };
  }
}

export { MSG_INEXISTENTE };
