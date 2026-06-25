const DOC_APPS = [
  'pdf',
  'msword',
  'rtf',
  'json',
  'xml',
  'csv',
  'vnd.openxmlformats-officedocument.wordprocessingml.document',
  'vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'vnd.openxmlformats-officedocument.presentationml.presentation',
  'vnd.ms-excel',
  'vnd.ms-powerpoint',
  'zip',
  'x-7z-compressed',
  'x-rar-compressed',
  'x-tar',
];

const IMAGE_EXT = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'heic', 'heif', 'avif',
];

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'wmv'];

const AUDIO_EXT = [
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'amr', 'opus', 'wma',
];

function classifyByExtension(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'document';
}

export function classifyMediaType(mimeType, fileName) {
  const mt = String(mimeType || '').toLowerCase().trim();
  const [main, subtype = ''] = mt.split('/');

  if (['image', 'video', 'audio'].includes(main)) return main;
  if (main === 'text') return 'document';
  if (main === 'application' && DOC_APPS.some((s) => subtype.includes(s))) return 'document';
  return classifyByExtension(fileName);
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').replace(/quicktime/gi, 'mp4');
}

export function extractFileName(keyRedis) {
  if (!keyRedis) return '';
  const url = String(keyRedis);
  const marker = '/n8n/';
  const idx = url.indexOf(marker);
  const raw = idx >= 0 ? url.slice(idx + marker.length) : url.split('/').pop() || url;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function probeMedia(keyRedis) {
  const res = await fetch(keyRedis, { method: 'HEAD', redirect: 'follow' });
  const mimeType = normalizeMimeType(
    res.headers.get('content-type') || 'application/octet-stream',
  );
  const fileName = extractFileName(keyRedis);
  const mediaType = classifyMediaType(mimeType, fileName);
  return { mimeType, mediaType, fileName };
}
