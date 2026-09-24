const KNOWLEDGE_CONTEXT_MAX_CHARS = 16_000;

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

/** Fallback para produtos antigos que estão no JSON do agente, mas ainda não no vetor. */
export function selectAgentProductDocuments(rawProducts, query, limit = 5) {
  const products = parseProducts(rawProducts);
  if (!products.length) return [];

  const terms = normalizeForSearch(query)
    .split(' ')
    .filter((term) => term.length >= 3);
  return products
    .map((product, index) => {
      const serialized = JSON.stringify(product, null, 2);
      const searchable = normalizeForSearch(serialized);
      const score = terms.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0);
      return { product, serialized, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, limit))
    .map(({ serialized }) => ({
      content: `Tipo de conhecimento: produto cadastrado\nDados exatos do produto:\n${serialized}`,
      metadata: { source: 'agente.produtos' },
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
