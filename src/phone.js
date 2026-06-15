export function normalizePhone(raw) {
  if (raw == null) return null;

  let value = String(raw).trim();
  if (!value) return null;

  value = value.replace(/@s\.whatsapp\.net$/i, '');
  const digits = value.replace(/\D/g, '');

  return digits || null;
}

/** BR celular: 55 + DDD(2) + 9 + 8 dígitos = 13. Fixo: 12 dígitos, local começa com 2-5. */
export function addBrazilMobileNine(digits) {
  if (!digits?.startsWith('55') || digits.length !== 12) return null;
  return `${digits.slice(0, 4)}9${digits.slice(4)}`;
}

export function removeBrazilMobileNine(digits) {
  if (!digits?.startsWith('55') || digits.length !== 13 || digits[4] !== '9') return null;
  return `${digits.slice(0, 4)}${digits.slice(5)}`;
}

function isBrazilLandlineLocal(local) {
  return /^[2-5]\d{7}$/.test(local);
}

function isBrazilMobileLocalWithoutNine(local) {
  return /^[6-9]\d{7}$/.test(local);
}

/**
 * Escolhe UM formato correto antes do envio (evita duplicar com/sem 9).
 * - Fixo (2-5): mantém 12 dígitos, sem 9
 * - Celular antigo (6-9): insere 9
 * - 13 dígitos com 9 errado em fixo: remove o 9
 */
export function resolveBrazilPhoneForMeta(digits) {
  if (!digits?.startsWith('55')) {
    return { phone: digits, action: 'unchanged' };
  }

  if (digits.length === 12) {
    const local = digits.slice(4);
    if (isBrazilLandlineLocal(local)) {
      return { phone: digits, action: 'fixo-12' };
    }
    if (isBrazilMobileLocalWithoutNine(local)) {
      return { phone: addBrazilMobileNine(digits), action: 'add-nine' };
    }
    return { phone: digits, action: 'unchanged' };
  }

  if (digits.length === 13 && digits[4] === '9') {
    const localWithoutNine = digits.slice(5);
    if (isBrazilLandlineLocal(localWithoutNine)) {
      return { phone: removeBrazilMobileNine(digits), action: 'remove-nine-fixo' };
    }
    return { phone: digits, action: 'celular-13' };
  }

  return { phone: digits, action: 'unchanged' };
}

function getAlternateBrazilPhone(phone) {
  return removeBrazilMobileNine(phone) || addBrazilMobileNine(phone);
}

/**
 * Retorna candidatos: [formato escolhido] + alternativa só se Meta rejeitar (não envia os dois).
 */
export function getPhoneCandidatesForMeta(raw) {
  const original = normalizePhone(raw);
  if (!original) return { candidates: [], resolution: null };

  if (!original.startsWith('55')) {
    return {
      candidates: [original],
      resolution: { phone: original, action: 'unchanged', original },
    };
  }

  const resolution = { ...resolveBrazilPhoneForMeta(original), original };
  const candidates = [resolution.phone];

  const alternate = getAlternateBrazilPhone(resolution.phone);
  if (alternate && alternate !== resolution.phone) {
    candidates.push(alternate);
  }

  return { candidates: [...new Set(candidates)], resolution };
}

export function formatPhoneForLog(digits) {
  if (!digits) return null;
  if (digits.startsWith('55') && digits.length >= 12) {
    return `+${digits.slice(0, 2)} (${digits.slice(2, 4)}) ${digits.slice(4)}`;
  }
  return digits;
}
