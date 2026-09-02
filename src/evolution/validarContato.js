import { logger } from '../logger.js';
import { normalizePhone, resolveBrazilPhoneForMeta } from '../phone.js';
import { isInstanceConnectionOpen } from './client.js';
import { extractLidFromWhatsAppNumbersRow, isLidJid, normalizeLidJid } from './lid.js';
import { getValidationNumberCandidates, phonesMatch } from './phoneVariants.js';
import { persistValidatedContactPhone } from './mergeContatos.js';
import * as evolutionDb from './supabase.js';
import { isUazapiConnected } from '../uazapi/client.js';

export const MSG_INEXISTENTE = 'Contato inexistente';
export const REASON_INSTANCE_NOT_OPEN = 'instance_not_open';
export const REASON_AMBIGUOUS = 'ambiguous_result';
export const REASON_API_ERROR = 'api_error';

function toPhoneJid(digits) {
  return `${digits}@s.whatsapp.net`;
}

function rowMatchesCandidate(row, candidate) {
  return phonesMatch(row?.number, candidate) || phonesMatch(row?.jid, candidate);
}

function finalizeValidMatch(match, candidateHint) {
  let jid = match?.jid;
  if (!jid) {
    const digits = normalizePhone(match?.number) || candidateHint;
    if (!digits) return null;
    jid = isLidJid(match?.number) ? normalizeLidJid(match.number) : toPhoneJid(digits);
    match = { ...match, jid };
  }

  const candidate = candidateHint || normalizePhone(match.number) || normalizePhone(jid);
  if (!candidate) return match;

  const { phone: resolved, action } = resolveBrazilPhoneForMeta(candidate);
  if (action === 'fixo-12' || action === 'remove-nine-fixo') {
    const jidDigits = normalizePhone(match.jid);
    if (jidDigits !== resolved) {
      logger.warn('whatsappNumbers reescreveu fixo com 9 — usando o número original', {
        candidate,
        jidRecebido: match.jid,
        jidUsado: toPhoneJid(resolved),
      });
      return { ...match, jid: toPhoneJid(resolved) };
    }
  }

  return match;
}

/**
 * Aceita variação de jid / número / 9º dígito via phonesMatch.
 * Fallback: qualquer exists:true com jid/number (formato inesperado ≠ inexistente).
 */
function pickValidWhatsAppResult(results, candidates) {
  if (!Array.isArray(results)) return null;

  for (const candidate of candidates) {
    const match = results.find(
      (row) => row?.exists === true && rowMatchesCandidate(row, candidate),
    );
    if (!match) continue;
    const finalized = finalizeValidMatch(match, candidate);
    if (finalized?.jid) return finalized;
  }

  const anyValid = results.find((row) => row?.exists === true && (row?.jid || row?.number));
  if (anyValid) {
    return finalizeValidMatch(anyValid, candidates[0] || normalizePhone(anyValid.number));
  }

  return null;
}

/** exists:false explícito para ao menos um dos candidatos consultados. */
function hasExplicitExistsFalse(results, candidates) {
  if (!Array.isArray(results) || !results.length || !candidates?.length) return false;

  return candidates.some((candidate) =>
    results.some((row) => row?.exists === false && rowMatchesCandidate(row, candidate)),
  );
}

/** Só true com confirmação de open/connected. Falha/ausência de check ⇒ false. */
async function isInstanceConfirmedOpen(evolutionClient, instanceName) {
  try {
    if (typeof evolutionClient?.getConnectionState === 'function' && instanceName) {
      const statePayload = await evolutionClient.getConnectionState(instanceName);
      return isInstanceConnectionOpen(statePayload);
    }
    if (typeof evolutionClient?.getStatus === 'function') {
      const statePayload = await evolutionClient.getStatus();
      return isUazapiConnected(statePayload);
    }
  } catch (err) {
    logger.warn('Não foi possível confirmar connectionState na validação', {
      instanceName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}

async function rejectWithoutValidMatch({
  detalhe,
  evolutionClient,
  instanceName,
  results,
  candidates,
}) {
  const open = await isInstanceConfirmedOpen(evolutionClient, instanceName);
  if (!open) {
    logger.warn('Validação sem match — instância não confirmada open (transitório)', {
      detailId: detalhe.id,
      instanceName,
    });
    return { ok: false, reason: REASON_INSTANCE_NOT_OPEN };
  }

  if (hasExplicitExistsFalse(results, candidates)) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  logger.warn('Validação ambígua/vazia — não marcando contato inexistente', {
    detailId: detalhe.id,
    instanceName,
    resultsCount: Array.isArray(results) ? results.length : 0,
  });
  return { ok: false, reason: REASON_AMBIGUOUS };
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
    let jid = contato.telefone;
    let idContato = contato.id;
    const digits = normalizePhone(jid);
    if (digits && !isLidJid(jid)) {
      const { phone, action } = resolveBrazilPhoneForMeta(digits);
      if (action === 'remove-nine-fixo' && phone) {
        const jidCorrigido = toPhoneJid(phone);
        if (jidCorrigido !== contato.telefone) {
          logger.warn('Contato validado com 9 em número fixo — corrigindo destino', {
            contatoId: contato.id,
            telefoneSalvo: contato.telefone,
            jidCorrigido,
          });
          const contaId = detalhe.UserId || contato.contaId;
          try {
            const persisted = await persistValidatedContactPhone({
              contatoId: contato.id,
              contaId,
              jid: jidCorrigido,
            });
            jid = persisted.jid;
            idContato = persisted.idContato;
          } catch (err) {
            logger.error('Erro ao persistir correção de fixo com 9', {
              contatoId: contato.id,
              message: err instanceof Error ? err.message : String(err),
            });
            jid = jidCorrigido;
          }
        }
      }
    }
    return {
      ok: true,
      jid,
      idContato,
      lid: normalizeLidJid(contato.lid),
    };
  }

  const instanceName = detalhe.InstanceName;
  if (!instanceName) {
    logger.warn('Disparo sem InstanceName para validação (transitório)', { detailId: detalhe.id });
    return { ok: false, reason: REASON_INSTANCE_NOT_OPEN };
  }

  const candidates = getValidationNumberCandidates(contato.telefone);
  if (!candidates.length) {
    return { ok: false, reason: MSG_INEXISTENTE };
  }

  let results;
  try {
    if (typeof evolutionClient.checkWhatsAppNumbers === 'function') {
      results = await evolutionClient.checkWhatsAppNumbers(instanceName, candidates);
    } else if (typeof evolutionClient.checkNumber === 'function') {
      results = [];
      for (const candidate of candidates) {
        const row = await evolutionClient.checkNumber(candidate);
        const rawExists = row?.exists ?? row?.isWA ?? row?.whatsapp;
        const exists =
          rawExists === undefined || rawExists === null ? undefined : Boolean(rawExists);
        results.push({
          exists,
          jid: row?.jid || (exists === true ? `${candidate}@s.whatsapp.net` : null),
          number: candidate,
        });
        if (exists === true) break;
      }
    } else {
      throw new Error('Cliente sem checkWhatsAppNumbers/checkNumber');
    }
  } catch (err) {
    logger.warn('Falha na API whatsappNumbers', {
      detailId: detalhe.id,
      message: err instanceof Error ? err.message : String(err),
    });
    // Erro de API/instância ≠ número inválido — só exists:false marca inexistente.
    return { ok: false, reason: REASON_API_ERROR, error: err };
  }

  if (!Array.isArray(results)) {
    results = Array.isArray(results?.numbers) ? results.numbers : [];
  }

  const valid = pickValidWhatsAppResult(results, candidates);
  if (!valid?.jid) {
    return rejectWithoutValidMatch({
      detalhe,
      evolutionClient,
      instanceName,
      results,
      candidates,
    });
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
    // Persistência falhou — não confundir com número inexistente.
    return { ok: false, reason: REASON_AMBIGUOUS, error: err };
  }
}
