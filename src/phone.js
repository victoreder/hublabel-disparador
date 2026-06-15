export function normalizePhone(raw) {
  if (raw == null) return null;

  let value = String(raw).trim();
  if (!value) return null;

  value = value.replace(/@s\.whatsapp\.net$/i, '');
  const digits = value.replace(/\D/g, '');

  return digits || null;
}

/** BR celular: 55 + DDD(2) + 9 + 8 dígitos = 13. Antigo: 12 dígitos sem o 9. */
export function addBrazilMobileNine(digits) {
  if (!digits?.startsWith('55') || digits.length !== 12) return null;
  return `${digits.slice(0, 4)}9${digits.slice(4)}`;
}

export function removeBrazilMobileNine(digits) {
  if (!digits?.startsWith('55') || digits.length !== 13 || digits[4] !== '9') return null;
  return `${digits.slice(0, 4)}${digits.slice(5)}`;
}

/**
 * Variantes para envio Meta (prioridade: com nono dígito primeiro).
 * Ex.: 554884549300 → tenta 5548984549300, depois 554884549300
 */
export function getPhoneCandidatesForMeta(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return [];

  if (!digits.startsWith('55')) {
    return [digits];
  }

  const withNine = addBrazilMobileNine(digits);
  const withoutNine = removeBrazilMobileNine(digits);

  if (digits.length === 12 && withNine) {
    return [withNine, digits];
  }

  if (digits.length === 13 && digits[4] === '9' && withoutNine) {
    return [digits, withoutNine];
  }

  return [digits];
}

export function formatPhoneForLog(digits) {
  if (!digits) return null;
  if (digits.startsWith('55') && digits.length >= 12) {
    return `+${digits.slice(0, 2)} (${digits.slice(2, 4)}) ${digits.slice(4)}`;
  }
  return digits;
}
