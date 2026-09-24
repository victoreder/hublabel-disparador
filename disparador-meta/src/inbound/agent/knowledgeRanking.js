const STOP_WORDS = new Set([
  'a',
  'ao',
  'como',
  'da',
  'de',
  'do',
  'e',
  'eu',
  'mais',
  'me',
  'o',
  'para',
  'por',
  'quero',
  'saber',
  'sobre',
  'um',
  'uma',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function queryTerms(query) {
  return normalize(query)
    .split(' ')
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

function documentKey(document) {
  const idUnico = document?.metadata?.idUnico ?? document?.metadata?.id_unico;
  const content = String(document?.content || '').trim();
  return idUnico ? `id:${idUnico}:${content}` : `content:${content}`;
}

function lexicalScore(document, terms) {
  const content = normalize(document?.content);
  if (!content || !terms.length) return 0;

  let score = terms.reduce((total, term) => total + (content.includes(term) ? 3 : 0), 0);
  const phrase = terms.join(' ');
  if (terms.length > 1 && content.includes(phrase)) score += 20;
  if (
    phrase &&
    /(nome do produto|"nome"|nome produto)/.test(content) &&
    content.includes(phrase)
  ) {
    score += 10;
  }
  return score;
}

export function rankKnowledgeDocuments({ vectorDocuments = [], linkedDocuments = [], query, limit = 5 }) {
  const merged = new Map();
  for (const document of [...vectorDocuments, ...linkedDocuments]) {
    if (!String(document?.content || '').trim()) continue;
    const key = documentKey(document);
    const existing = merged.get(key);
    if (!existing || Number(document?.similarity ?? -1) > Number(existing?.similarity ?? -1)) {
      merged.set(key, document);
    }
  }

  const terms = queryTerms(query);
  return [...merged.values()]
    .map((document) => ({
      ...document,
      lexicalScore: lexicalScore(document, terms),
    }))
    .sort(
      (a, b) =>
        b.lexicalScore - a.lexicalScore ||
        Number(b.similarity ?? -1) - Number(a.similarity ?? -1),
    )
    .slice(0, Math.max(1, limit));
}
