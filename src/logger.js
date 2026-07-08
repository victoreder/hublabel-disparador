function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return '';
  return ` ${JSON.stringify(meta)}`;
}

export const logger = {
  info(message, meta) {
    console.log(`[INFO] ${new Date().toISOString()} ${message}${formatMeta(meta)}`);
  },
  warn(message, meta) {
    console.warn(`[WARN] ${new Date().toISOString()} ${message}${formatMeta(meta)}`);
  },
  error(message, meta) {
    console.error(`[ERROR] ${new Date().toISOString()} ${message}${formatMeta(meta)}`);
  },
};
