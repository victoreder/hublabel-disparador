import { logger } from '../logger.js';
import { normalizePhone, resolveBrazilPhoneForMeta } from '../phone.js';
import { extractLidFromWhatsAppNumbersRow, isLidJid, normalizeLidJid } from './lid.js';
import { getValidationNumberCandidates } from './phoneVariants.js';
import { persistValidatedContactPhone } from './mergeContatos.js';
import * as evolutionDb from './supabase.js';

const MSG_INEXISTENTE = 'Contato inexistente';

function toPhoneJid(digits) {
  return `${digits}@s.whatsapp.net`;
}

function pickValidWhatsAppResult(results, candidates) {
  if (!Array.isArray(results)) return null;

  for (const candidate of candidates) {
    const match = results.find((row) => {
      if (row?.exists !== true || !row?.jid) return false;
      const queried = normalizePhone(row.number);
      const jidDigits = normalizePhone(row.jid);
      return queried === candidate || jidDigits === candidate;
    });
    if (!match?.jid) continue;

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

  return null;
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
