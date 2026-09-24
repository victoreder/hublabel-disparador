import { extractPublicProductMedia } from '../rag/productMediaUpload.js';

const KNOWLEDGE_CONTEXT_MAX_CHARS = 16_000;
const PRODUCT_DOCUMENT_MAX_CHARS = 8_000;
const PRODUCT_STRING_MAX_CHARS = 2_000;
const PRODUCT_ARRAY_MAX_ITEMS = 20;
const PRODUCT_MAX_DEPTH = 5;
const BINARY_FIELD_PATTERN =
  /(?:base64|buffer|bytes|binary|blob|dataurl|data_url|filedata|arquivo(?:base64|conteudo)|conteudoarquivo|previewbase64)/i;

function normalizeForSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

function productName(product) {
  return normalizeForSearch(product?.nome ?? product?.name ?? product?.titulo ?? product?.title);
}

function documentProductName(document) {
  const content = String(document?.content || '');
  const labeled = content.match(/(?:Nome do produto|Produto)\s*:\s*([^\n]+)/i)?.[1];
  if (labeled) return normalizeForSearch(labeled);
  const jsonName = content.match(/["'](?:nome|name|titulo|title)["']\s*:\s*["']([^"']+)/i)?.[1];
  return normalizeForSearch(jsonName);
}

/** Impede que vetores órfãos de produtos removidos sejam usados em respostas. */
export function filterCurrentAgentProductDocuments(documents, rawProducts) {
  if (rawProducts == null) return Array.isArray(documents) ? documents : [];
  const products = parseProducts(rawProducts);
  const activeIds = new Set(
    products
      .map((product) => String(product?.id ?? product?.idUnico ?? product?.id_unico ?? '').trim())
      .filter(Boolean),
  );
  const activeNames = new Set(products.map(productName).filter(Boolean));

  return (Array.isArray(documents) ? documents : []).filter((document) => {
    const idUnico = String(
      document?.metadata?.idUnico ?? document?.metadata?.id_unico ?? '',
    ).trim();
    if (!idUnico.startsWith('prod_') && !idUnico.startsWith('produto-')) return true;
    if (activeIds.has(idUnico)) return true;
    const name = documentProductName(document);
    return Boolean(name && activeNames.has(name));
  });
}

function sanitizeProductValue(value, key = '', depth = 0) {
  if (value == null || depth > PRODUCT_MAX_DEPTH || BINARY_FIELD_PATTERN.test(key)) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || /^(?:data|blob):/i.test(text)) return undefined;
    if (text.length > 4_096 && /^[a-z0-9+/=\s]+$/i.test(text)) return undefined;
    const maxChars = /^https:\/\//i.test(text) ? 4_096 : PRODUCT_STRING_MAX_CHARS;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, PRODUCT_ARRAY_MAX_ITEMS)
      .map((item) => sanitizeProductValue(item, key, depth + 1))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }

  if (typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) return undefined;
    const entries = Object.entries(value)
      .map(([childKey, childValue]) => [
        childKey,
        sanitizeProductValue(childValue, childKey, depth + 1),
      ])
      .filter(([, childValue]) => childValue !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  return undefined;
}

function serializeProduct(product) {
  const sanitized = sanitizeProductValue(product) ?? {};
  const serialized = JSON.stringify(sanitized, null, 2);
  if (serialized.length <= PRODUCT_DOCUMENT_MAX_CHARS) return serialized;
  return `${serialized.slice(0, PRODUCT_DOCUMENT_MAX_CHARS)}\n[conteúdo adicional omitido]`;
}

/** Fallback para produtos antigos que estão no JSON do agente, mas ainda não no vetor. */
export function selectAgentProductDocuments(rawProducts, query, limit = 5) {
  const products = parseProducts(rawProducts);
  if (!products.length) return [];

  const terms = normalizeForSearch(query)
    .split(' ')
    .filter((term) => term.length >= 3);
  return products
    .map((product, index) => {
      const serialized = serializeProduct(product);
      const searchable = normalizeForSearch(serialized);
      const score = terms.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0);
      return { product, serialized, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, limit))
    .map(({ product, serialized }) => ({
      content: `Tipo de conhecimento: produto cadastrado\nDados exatos do produto:\n${serialized}`,
      metadata: {
        source: 'agente.produtos',
        midias: extractPublicProductMedia(product),
      },
      similarity: null,
    }));
}

export function buildKnowledgeContext(documents) {
  if (!Array.isArray(documents) || !documents.length) return null;

  const blocks = documents
    .map((document, index) => {
      const content = typeof document === 'string' ? document : document?.content;
      if (!String(content || '').trim()) return null;
      return `### Resultado ${index + 1}\n${String(content).trim()}`;
    })
    .filter(Boolean);
  if (!blocks.length) return null;

  const context = [
    '## CONHECIMENTO RECUPERADO PARA ESTA PERGUNTA',
    'Use estes dados como fonte principal. Prefira uma resposta curta e objetiva.',
    'Copie preços, nomes, características e links exatamente como estão. Não substitua por conhecimento geral.',
    'Se houver mídia útil, envie-a em um bloco separado no formato [nome (image)](URL) ou [nome (video)](URL).',
    'Se a informação pedida não estiver nos resultados, diga que ela não está cadastrada; não invente.',
    '',
    ...blocks,
  ].join('\n');

  return context.slice(0, KNOWLEDGE_CONTEXT_MAX_CHARS);
}
