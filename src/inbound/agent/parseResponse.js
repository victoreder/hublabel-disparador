const MEDIA_URL_RE = /\]\((https?:\/\/[^)]+)\)\s*$/m;

export function splitAgentOutput(output, separarMensagens = true) {
  const text = String(output || '').trim();
  if (!text) return [];

  if (!separarMensagens) return [{ kind: classifyChunk(text), text }];

  return text
    .split(/\r?\n\s*\r?\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({ kind: classifyChunk(chunk), text: chunk }));
}

export function classifyChunk(text) {
  const lower = text.toLowerCase();
  if (lower.includes('(image)')) return 'image';
  if (lower.includes('(video)')) return 'video';
  if (lower.includes('(audio)')) return 'audio';
  if (lower.includes('(file)') || lower.includes('(pdf)')) return 'document';
  return 'text';
}

export function extractMediaUrl(text) {
  const match = String(text || '').match(MEDIA_URL_RE);
  return match?.[1] || null;
}

export function plainTextFromChunk(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .trim();
}

export function guessMimeFromUrl(url) {
  const ext = String(url || '').toLowerCase().split('?')[0].split('.').pop();
  const map = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

export function fileNameFromUrl(url) {
  const fileName = String(url || '').split('?')[0].split('/').pop();
  return decodeURIComponent(fileName || 'arquivo');
}
