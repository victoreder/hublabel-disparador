import {
  addBrazilMobileNine,
  normalizePhone,
  removeBrazilMobileNine,
  resolveBrazilPhoneForMeta,
} from '../phone.js';

function isLandlineResolution(action) {
  return action === 'fixo-12' || action === 'remove-nine-fixo';
}

/**
 * Variantes BR para whatsappNumbers.
 * Celular: com e sem 9 (mesmo número em formatos antigo/novo).
 * Fixo (local 2-5): só o 12 dígitos — 3333-4444 e 93333-4444 são números diferentes.
 */
export function getValidationNumberCandidates(raw) {
  const original = normalizePhone(raw);
  if (!original) return [];

  if (!original.startsWith('55')) {
    return [original];
  }

  const { phone, action } = resolveBrazilPhoneForMeta(original);

  if (isLandlineResolution(action)) {
    return [phone];
  }

  const candidates = new Set([original, phone]);
  const alt = removeBrazilMobileNine(phone) || addBrazilMobileNine(phone);
  if (alt) candidates.add(alt);

  return [...candidates].filter(Boolean);
}

export function phonesMatch(a, b) {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  if (!da || !db) return false;
  if (da === db) return true;

  if (da.startsWith('55') && db.startsWith('55')) {
    const altA = removeBrazilMobileNine(da) || addBrazilMobileNine(da);
    const altB = removeBrazilMobileNine(db) || addBrazilMobileNine(db);
    return da === altB || db === altA || altA === altB;
  }

  return false;
}
