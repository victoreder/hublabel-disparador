import { HttpError } from '../meta/httpError.js';

const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'webp']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm']);
const DEFAULT_MAX_MEDIA_ITEMS = 20;
const MAX_URL_LENGTH = 4096;

function optionalPositiveInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMediaInput(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [trimmed];
    }
  }

  if (typeof raw === 'object') return [raw];
  throw new HttpError('midias deve ser uma lista JSON de links', 400);
}

function parseObjectInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstPresent(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (source[key] != null && source[key] !== '') return source[key];
    }
  }
  return null;
}

function normalizeMediaType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['image', 'imagem', 'foto'].includes(normalized)) return 'imagem';
  if (['video', 'vídeo'].includes(normalized)) return 'video';
  if (normalized.startsWith('image/')) return 'imagem';
  if (normalized.startsWith('video/')) return 'video';
  return null;
}

function extensionFromUrl(url) {
  const filename = new URL(url).pathname.split('/').pop() || '';
  return filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

function inferMediaType({ explicitType, mimeType, url }) {
  const declared = normalizeMediaType(explicitType) || normalizeMediaType(mimeType);
  if (declared) return declared;

  const extension = extensionFromUrl(url);
  if (IMAGE_EXTENSIONS.has(extension)) return 'imagem';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function allowedHostsFromEnv() {
  return String(process.env.RAG_MEDIA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeUrl(value, index) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new HttpError(`midias[${index}].url é obrigatório`, 400);
  if (raw.length > MAX_URL_LENGTH) {
    throw new HttpError(`midias[${index}].url excede ${MAX_URL_LENGTH} caracteres`, 400);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(`midias[${index}].url é inválido`, 400);
  }

  if (parsed.protocol !== 'https:') {
    throw new HttpError(`midias[${index}].url deve usar HTTPS`, 400);
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(`midias[${index}].url não pode conter credenciais`, 400);
  }

  const allowedHosts = allowedHostsFromEnv();
  if (allowedHosts.length && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new HttpError(`midias[${index}].url usa um domínio não permitido`, 400);
  }

  return parsed.toString();
}

function normalizeOptionalText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeMediaItem(item, index) {
  const source = typeof item === 'string' ? { url: item } : item;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new HttpError(`midias[${index}] deve ser um link ou objeto`, 400);
  }

  const nestedSources = [
    source,
    source.arquivo,
    source.file,
    source.midia,
    source.media,
    source.imagem,
    source.foto,
  ];
  const url = normalizeUrl(
    firstPresent(nestedSources, [
      'url',
      'link',
      'src',
      'objectUrl',
      'mediaUrl',
      'publicUrl',
      'downloadUrl',
      'arquivoUrl',
      'urlArquivo',
      'fotoUrl',
      'imagemUrl',
      'videoUrl',
      'url_publica',
    ]),
    index,
  );
  const mimeType = normalizeOptionalText(
    firstPresent(nestedSources, [
      'mimeType',
      'mimetype',
      'contentType',
      'content_type',
      'mime',
    ]),
    100,
  );
  const tipo = inferMediaType({
    explicitType: firstPresent(nestedSources, [
      'tipo',
      'type',
      'mediaType',
      'tipoArquivo',
      'tipoMidia',
    ]),
    mimeType,
    url,
  });

  if (!tipo) {
    throw new HttpError(
      `midias[${index}].tipo é obrigatório quando o link não identifica imagem ou vídeo`,
      400,
    );
  }

  const tamanhoRaw = source.tamanho ?? source.size ?? null;
  const tamanho = tamanhoRaw == null || tamanhoRaw === '' ? null : Number(tamanhoRaw);
  if (tamanho != null && (!Number.isFinite(tamanho) || tamanho < 0)) {
    throw new HttpError(`midias[${index}].tamanho é inválido`, 400);
  }

  const ordemRaw = source.ordem ?? source.order ?? index + 1;
  const ordem = Number.parseInt(ordemRaw, 10);
  if (!Number.isInteger(ordem) || ordem < 1) {
    throw new HttpError(`midias[${index}].ordem é inválida`, 400);
  }

  return {
    id: normalizeOptionalText(source.id, 200) ?? `midia-${index + 1}`,
    tipo,
    url,
    mimeType,
    tamanho,
    ordem,
    descricao: normalizeOptionalText(
      source.descricao ?? source.description ?? source.altText ?? source.legenda,
      1000,
    ),
  };
}

export function normalizeMediaLinks(body = {}) {
  const product = parseObjectInput(body.produto ?? body.product);
  const keys = [
    'midias',
    'medias',
    'media',
    'arquivos',
    'anexos',
    'galeria',
    'linksMidia',
    'mediaUrls',
    'fotos',
    'foto',
    'imagens',
    'imagem',
    'images',
    'videos',
    'video',
  ];
  const items = [body, product]
    .filter(Boolean)
    .flatMap((source) => keys.flatMap((key) => parseMediaInput(source[key])));
  const maxItems = optionalPositiveInt(process.env.RAG_MAX_MEDIA_ITEMS, DEFAULT_MAX_MEDIA_ITEMS);

  if (items.length > maxItems) {
    throw new HttpError(`O produto aceita no máximo ${maxItems} mídias`, 400);
  }

  const seen = new Set();
  return items
    .map(normalizeMediaItem)
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((a, b) => a.ordem - b.ordem);
}

export function appendMediaLinksToText(text, media) {
  const baseText = String(text ?? '').trim();
  if (!media?.length) return baseText;

  const lines = media.flatMap((item, index) => {
    const label = item.tipo === 'imagem' ? 'Imagem' : 'Vídeo';
    const result = [`${label} ${index + 1}: ${item.url}`];
    if (item.descricao) result.push(`Descrição da mídia ${index + 1}: ${item.descricao}`);
    return result;
  });

  return [baseText, 'Mídias do produto:', ...lines].filter(Boolean).join('\n');
}
