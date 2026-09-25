import { EvolutionError } from './client.js';
import { getValidationNumberCandidates, phonesMatch } from './phoneVariants.js';

const LID_SUFFIX = '@lid';

/** Nack 463 (NackCallerReachoutTimelocked): telefone falha em conta migrada para @lid. */
const FALLBACK_HINTS = ['463', 'timelocked', 'reachout', 'not-authorized', 'forbidden'];

export function isLidJid(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .endsWith(LID_SUFFIX);
}

/** Normaliza para "<digitos>@lid". Retorna null para telefones ou valores vazios. */
export function normalizeLidJid(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.includes('@') && !isLidJid(raw)) return null;

  const digits = raw.replace(/@.*$/, '').replace(/\D/g, '');
  if (!digits) return null;

  return `${digits}${LID_SUFFIX}`;
}

export function extractLidFromWhatsAppNumbersRow(row) {
  if (!row || typeof row !== 'object') return null;

  const candidates = [row.lid, row.jidLid, row.lidJid, isLidJid(row.jid) ? row.jid : null];
  for (const candidate of candidates) {
    const lid = normalizeLidJid(candidate);
    if (lid) return lid;
  }

  return null;
}

/**
 * Falhas que podem ser só endereçamento errado (telefone x @lid) — vale tentar o outro JID.
 * Desconexão/timeout ficam de fora: repetir na mesma conexão morta não resolve.
 */
export function isEnderecamentoFallbackError(err) {
  if (!(err instanceof EvolutionError)) return false;
  if (err.status === 502 || err.status === 504 || err.status === 500) return false;

  const texto = [
    err.messageText,
    err.message,
    typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? ''),
  ]
    .join(' ')
    .toLowerCase();

  if (FALLBACK_HINTS.some((hint) => texto.includes(hint))) return true;

  return err.status === 400;
}

/**
 * Consulta o @lid de um telefone via /chat/whatsappNumbers (a Evolution já resolve
 * internamente; não há endpoint dedicado).
 */
export async function resolveLidDoTelefone({ evolutionClient, instanceName, telefone }) {
  if (!evolutionClient || !instanceName || !telefone) return null;

  const candidates = getValidationNumberCandidates(telefone);
  if (!candidates.length) return null;

  let results;
  try {
    results = await evolutionClient.checkWhatsAppNumbers(instanceName, candidates);
  } catch {
    return null;
  }

  if (!Array.isArray(results)) return null;

  const match =
    results.find(
      (row) => row?.exists === true && (phonesMatch(row.number, telefone) || phonesMatch(row.jid, telefone)),
    ) ?? results.find((row) => row?.exists === true);

  return extractLidFromWhatsAppNumbersRow(match);
}
