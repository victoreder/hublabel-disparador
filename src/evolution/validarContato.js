import { logger } from '../logger.js';
import { extractLidFromWhatsAppNumbersRow, normalizeLidJid } from './lid.js';
import { getValidationNumberCandidates } from './phoneVariants.js';
import { persistValidatedContactPhone } from './mergeContatos.js';
import * as evolutionDb from './supabase.js';

const MSG_INEXISTENTE = 'Contato inexistente';

function pickValidWhatsAppResult(results, candidates) {
  if (!Array.isArray(results)) return null;

  for (const candidate of candidates) {
    const match = results.find(
      (row) =>
        row?.exists === true &&
        row?.jid &&
        String(row.number || row.jid).replace(/\D/g, '') === candidate.replace(/\D/g, ''),
    );
    if (match?.jid) return match;
  }

  return results.find((row) => row?.exists === true && row?.jid) ?? null;
}

export async function ensureContactValidatedForDispatch(detalhe, evolutionClient) {
  if (!detalhe.idContato) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  const contato = await evolutionDb.fetchContato(detalhe.idContato);
  if (!contato) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  if (contato.validado === true && contato.telefone) {
    return {
      ok: true,
      jid: contato.telefone,
      idContato: contato.id,
      lid: normalizeLidJid(contato.lid),
    };
  }

  const instanceName = detalhe.InstanceName;
  if (!instanceName) {
    logger.warn('Disparo sem InstanceName para validação', { detailId: detalhe.id });
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  const candidates = getValidationNumberCandidates(contato.telefone);
  if (!candidates.length) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  let results;
  try {
    results = await evolutionClient.checkWhatsAppNumbers(instanceName, candidates);
  } catch (err) {
    logger.warn('Falha na API whatsappNumbers', {
      detailId: detalhe.id,
      message: err instanceof Error ? err.message : String(err),
    });
    // Erro de API/instância ≠ número inválido — só exists:false marca inexistente.
    return { ok: false, reason: 'api_error', error: err };
  }

  const valid = pickValidWhatsAppResult(results, candidates);
  if (!valid?.jid) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  const jid = String(valid.jid).includes('@') ? valid.jid : `${valid.jid}@s.whatsapp.net`;
  const contaId = detalhe.UserId || contato.contaId;
  // lid do contato (inbound) indica conta migrada; o da validação serve apenas como fallback.
  const lid = normalizeLidJid(contato.lid);
  const lidAlternativo = lid ? null : extractLidFromWhatsAppNumbersRow(valid);

  try {
    const persisted = await persistValidatedContactPhone({
      contatoId: contato.id,
      contaId,
      jid,
    });

    return {
      ok: true,
      jid: persisted.jid,
      idContato: persisted.idContato,
      lid,
      lidAlternativo,
    };
  } catch (err) {
    logger.error('Erro ao persistir contato validado', {
      detailId: detalhe.id,
      contatoId: contato.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: MSG_INEXISTENTE };
  }
}
