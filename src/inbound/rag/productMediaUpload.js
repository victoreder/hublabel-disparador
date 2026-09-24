import { createHash } from 'node:crypto';
import { HttpError } from '../meta/httpError.js';

const MEDIA_KEYS = [
  'midias',
  'medias',
  'media',
  'arquivos',
  'anexos',
  'galeria',
  'fotos',
  'foto',
  'imagens',
  'imagem',
  'images',
  'videos',
  'video',
];
const BASE64_KEYS = [
  'base64',
  'dataUrl',
  'data_url',
  'arquivoBase64',
  'fileBase64',
  'conteudoBase64',
];
const URL_KEYS = [
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
];
const NESTED_KEYS = ['arquivo', 'file', 'midia', 'media', 'imagem', 'foto'];
const MIME_EXTENSIONS = new Map([
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
]);

function matchesDeclaredMime(buffer, mimeType) {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mimeType === 'image/gif') return /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6));
  if (mimeType === 'image/webp') {
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  if (mimeType === 'image/avif') {
    return buffer.toString('ascii', 4, 12).startsWith('ftypavi');
  }
  if (mimeType === 'video/webm') {
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  }
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    return buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
  }
  return false;
}

function parseObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseProducts(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function productIdentity(product) {
  return String(product?.id ?? product?.idUnico ?? product?.id_unico ?? '').trim();
}

function productName(product) {
  return String(product?.nome ?? product?.name ?? product?.titulo ?? product?.title ?? '')
    .trim()
    .toLowerCase();
}

function parseItems(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (/^data:/i.test(trimmed) || /^https:\/\//i.test(trimmed)) return [trimmed];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [trimmed];
    }
  }
  return [raw];
}

function sourcesFor(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  return [item, ...NESTED_KEYS.map((key) => item[key]).filter(Boolean)];
}

function firstValue(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (source[key] != null && source[key] !== '') return source[key];
    }
  }
  return null;
}

function extractEncodedMedia(item) {
  if (typeof item === 'string' && /^data:/i.test(item.trim())) return item.trim();
  return firstValue(sourcesFor(item), BASE64_KEYS);
}

function existingPublicUrl(item) {
  if (typeof item === 'string' && /^https:\/\//i.test(item.trim())) return item.trim();
  const value = firstValue(sourcesFor(item), URL_KEYS);
  return /^https:\/\//i.test(String(value || '').trim()) ? String(value).trim() : null;
}

function decodeMedia(value, declaredMimeType, maxBytes) {
  let encoded = String(value || '').trim();
  let mimeType = String(declaredMimeType || '').trim().toLowerCase();
  const dataUrl = encoded.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (dataUrl) {
    mimeType = dataUrl[1].toLowerCase();
    encoded = dataUrl[2];
  }
  if (!encoded) throw new HttpError('Mídia base64 vazia', 400);
  if (!MIME_EXTENSIONS.has(mimeType)) {
    throw new HttpError(`Tipo de mídia base64 não suportado: ${mimeType || 'não informado'}`, 400);
  }

  const normalized = encoded.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length) throw new HttpError('Mídia base64 inválida', 400);
  if (buffer.length > maxBytes) {
    throw new HttpError(`Mídia excede o limite de ${maxBytes} bytes`, 400);
  }
  if (!matchesDeclaredMime(buffer, mimeType)) {
    throw new HttpError(`Conteúdo da mídia não corresponde ao tipo ${mimeType}`, 400);
  }
  return { buffer, mimeType, extension: MIME_EXTENSIONS.get(mimeType) };
}

function standardMediaItem(item, url, mimeType, size, order) {
  const sources = sourcesFor(item);
  const explicitType = String(firstValue(sources, ['tipo', 'type', 'mediaType']) || '').toLowerCase();
  const videoByUrl = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)(?:[?#]|$)/i.test(url);
  const tipo =
    explicitType.includes('video') || mimeType.startsWith('video/') || videoByUrl
      ? 'video'
      : 'imagem';
  return {
    id: String(firstValue(sources, ['id']) || `midia-${order}`),
    tipo,
    url,
    mimeType,
    tamanho: size ?? null,
    ordem: order,
    descricao:
      String(firstValue(sources, ['descricao', 'description', 'altText', 'legenda']) || '').trim() ||
      null,
  };
}

export function extractPublicProductMedia(rawProduct) {
  const product = parseObject(rawProduct);
  if (!product) return [];
  const seen = new Set();
  const media = [];
  for (const key of MEDIA_KEYS) {
    for (const item of parseItems(product[key])) {
      const url = existingPublicUrl(item);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      media.push(
        standardMediaItem(
          item,
          url,
          String(declaredMimeType(item) || ''),
          null,
          media.length + 1,
        ),
      );
    }
  }
  return media;
}

function declaredMimeType(item) {
  return firstValue(sourcesFor(item), ['mimeType', 'mimetype', 'contentType', 'content_type', 'mime']);
}

/** Converte mídias base64 do produto em URLs públicas antes da indexação. */
export async function materializeProductMedia(
  body,
  { upload, maxBytes = 20 * 1024 * 1024 } = {},
) {
  const nextBody = { ...(body || {}) };
  const rawProduct = nextBody.produto ?? nextBody.product;
  const product = parseObject(rawProduct);
  const targets = [nextBody, product].filter(Boolean);
  const uploadCache = new Map();
  const uploadedMedia = [];

  for (const target of targets) {
    for (const key of MEDIA_KEYS) {
      if (target[key] == null || target[key] === '') continue;
      const items = parseItems(target[key]);
      const normalizedItems = [];

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const publicUrl = existingPublicUrl(item);
        if (publicUrl) {
          normalizedItems.push(
            standardMediaItem(item, publicUrl, String(declaredMimeType(item) || ''), null, index + 1),
          );
          continue;
        }

        const encoded = extractEncodedMedia(item);
        if (!encoded) continue;
        if (typeof upload !== 'function') throw new Error('Upload de mídia do produto não configurado');
        const decoded = decodeMedia(encoded, declaredMimeType(item), maxBytes);
        const hash = createHash('sha256').update(decoded.buffer).digest('hex');
        let uploaded = uploadCache.get(hash);
        if (!uploaded) {
          uploaded = await upload({ ...decoded, hash, index });
          uploadCache.set(hash, uploaded);
        }
        const mediaItem = standardMediaItem(
          item,
          uploaded.url,
          decoded.mimeType,
          decoded.buffer.length,
          index + 1,
        );
        normalizedItems.push(mediaItem);
        uploadedMedia.push(mediaItem);
      }

      target[key] = normalizedItems;
    }
  }

  if (product) {
    if ('produto' in nextBody) {
      nextBody.produto = typeof rawProduct === 'string' ? JSON.stringify(product) : product;
    } else {
      nextBody.product = typeof rawProduct === 'string' ? JSON.stringify(product) : product;
    }
  }

  return { body: nextBody, product, uploadedMedia };
}

/** Recupera do agente campos (principalmente mídias) omitidos na requisição de indexação. */
export function mergeAgentProductIntoBody(body, productsRaw, idUnico) {
  const nextBody = { ...(body || {}) };
  const rawProduct = nextBody.produto ?? nextBody.product;
  const requestProduct = parseObject(rawProduct) ?? {};
  const products = parseProducts(productsRaw);
  const requestedId = productIdentity(requestProduct) || String(idUnico || '').trim();
  let savedProduct = products.find(
    (product) => requestedId && productIdentity(product) === requestedId,
  );

  if (!savedProduct) {
    const requestedName = productName(requestProduct) || productName(nextBody);
    const matches = products.filter(
      (product) => requestedName && productName(product) === requestedName,
    );
    if (matches.length === 1) savedProduct = matches[0];
  }
  if (!savedProduct) return nextBody;

  const merged = { ...savedProduct, ...requestProduct };
  if ('produto' in nextBody || !('product' in nextBody)) {
    nextBody.produto = typeof rawProduct === 'string' ? JSON.stringify(merged) : merged;
  } else {
    nextBody.product = typeof rawProduct === 'string' ? JSON.stringify(merged) : merged;
  }
  return nextBody;
}

export function replaceAgentProduct(productsRaw, product, idUnico) {
  if (!product) return null;
  let products;
  try {
    products = Array.isArray(productsRaw)
      ? [...productsRaw]
      : typeof productsRaw === 'string'
        ? JSON.parse(productsRaw)
        : productsRaw
          ? [productsRaw]
          : [];
  } catch {
    return null;
  }
  if (!Array.isArray(products) || !products.length) return null;

  const targetId = String(product.id ?? product.idUnico ?? idUnico ?? '');
  let index = products.findIndex(
    (item) => String(item?.id ?? item?.idUnico ?? '') === targetId && targetId,
  );
  if (index < 0) {
    const name = String(product.nome ?? product.name ?? '').trim().toLowerCase();
    const matches = products
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) => String(item?.nome ?? item?.name ?? '').trim().toLowerCase() === name);
    if (name && matches.length === 1) index = matches[0].itemIndex;
  }
  if (index < 0) return null;

  products[index] = { ...products[index], ...product };
  return products;
}
