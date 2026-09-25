import {
  addBrazilMobileNine,
  normalizePhone,
  removeBrazilMobileNine,
  resolveBrazilPhoneForMeta,
} from '../phone.js';

/**
 * Variantes BR para whatsappNumbers.
 * Celular com 13 dígitos: preserva o 9; ele não identifica um fixo.
 * Celular antigo com 12 dígitos e início 6-9: consulta também a forma com 9.
 * Fixo (local 2-5): só o 12 dígitos — 3333-4444 e 93333-4444 são números diferentes.
 */
export function getValidationNumberCandidates(raw) {
  const original = normalizePhone(raw);
  if (!original) return [];

  if (!original.startsWith('55')) {
    return [original];
  }

  const { phone, action } = resolveBrazilPhoneForMeta(original);

  if (action === 'fixo-12' || action === 'celular-13') {
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
    const altA = legacyBrazilMobileVariant(da);
    const altB = legacyBrazilMobileVariant(db);
    return Boolean(
      (altB && da === altB) ||
        (altA && db === altA) ||
        (altA && altB && altA === altB),
    );
  }

  return false;
}

function legacyBrazilMobileVariant(digits) {
  if (digits.length === 12 && /^[6-9]/.test(digits.slice(4, 5))) {
    return addBrazilMobileNine(digits);
  }
  if (digits.length === 13 && digits[4] === '9' && /^[6-9]/.test(digits.slice(5, 6))) {
    return removeBrazilMobileNine(digits);
  }
  return null;
}
