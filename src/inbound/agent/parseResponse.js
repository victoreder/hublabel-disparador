function extractMarkdownHref(text) {
  const s = String(text || '');
  const angled = s.match(/\]\(\s*<(https?:\/\/[^>]+)>\s*\)/);
  if (angled?.[1]) return angled[1].trim();

  const marker = s.search(/\]\(\s*https?:\/\//i);
  if (marker < 0) return null;
  const open = s.indexOf('(', marker);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        const href = s.slice(open + 1, i).trim();
        return /^https?:\/\//i.test(href) ? href : null;
      }
    }
  }
  return null;
}

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

function normalizeAssociationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((?:image|video|audio|file|pdf)\)/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mediaLabel(text) {
  const label = String(text || '').match(/\[([^\]]+)\]\(\s*<?https?:\/\//i)?.[1];
  return normalizeAssociationText(label);
}

/**
 * Modelos podem listar todos os textos antes das mídias. Quando a mídia traz o
 * nome do produto no label, reposiciona-a logo após o texto correspondente.
 */
export function groupLabeledMediaWithText(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const assignments = new Map();
  const assignedMedia = new Set();

  list.forEach((chunk, mediaIndex) => {
    if ((chunk?.kind || classifyChunk(chunk?.text || '')) === 'text') return;
    const label = mediaLabel(chunk?.text);
    if (!label) return;

    const textIndex = list.findIndex((candidate) => {
      if ((candidate?.kind || classifyChunk(candidate?.text || '')) !== 'text') return false;
      return normalizeAssociationText(candidate?.text).includes(label);
    });
    if (textIndex < 0) return;

    const grouped = assignments.get(textIndex) || [];
    grouped.push(chunk);
    assignments.set(textIndex, grouped);
    assignedMedia.add(mediaIndex);
  });

  if (!assignedMedia.size) return list;

  const ordered = [];
  list.forEach((chunk, index) => {
    if (assignedMedia.has(index)) return;
    ordered.push(chunk);
    if (assignments.has(index)) ordered.push(...assignments.get(index));
  });
  return ordered;
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
  return extractMarkdownHref(text);
}

/** Normaliza URL de midia para dedupe (sem query/hash). */
export function normalizeMediaUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw.split('?')[0].split('#')[0].replace(/\/$/, '');
  }
}

export function plainTextFromChunk(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\(\s*<(https?:\/\/[^>]+)>\s*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/(?:[^()]|\([^()]*\))+)\)/g, '$1')
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
