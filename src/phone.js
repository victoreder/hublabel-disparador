export function normalizePhone(raw) {
  if (raw == null) return null;

  let value = String(raw).trim();
  if (!value) return null;

  value = value.replace(/@s\.whatsapp\.net$/i, '');
  const digits = value.replace(/\D/g, '');

  return digits || null;
}
