import {
  addBrazilMobileNine,
  normalizePhone,
  removeBrazilMobileNine,
  resolveBrazilPhoneForMeta,
} from '../phone.js';

/** Variantes BR (com/sem 9) para whatsappNumbers — envia todas de uma vez. */
export function getValidationNumberCandidates(raw) {
  const original = normalizePhone(raw);
  if (!original) return [];

  if (!original.startsWith('55')) {
    return [original];
  }

  const { phone } = resolveBrazilPhoneForMeta(original);
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
