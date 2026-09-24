function normalizeMessage(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseProducts(rawProducts) {
  if (Array.isArray(rawProducts)) return rawProducts;
  if (rawProducts && typeof rawProducts === 'object') return [rawProducts];
  if (typeof rawProducts !== 'string' || !rawProducts.trim()) return [];
  try {
    const parsed = JSON.parse(rawProducts);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function catalogProductNames(rawProducts) {
  return parseProducts(rawProducts)
    .map((product) =>
      normalizeMessage(product?.nome ?? product?.name ?? product?.titulo ?? product?.title),
    )
    .filter((name) => name.length >= 3);
}

/**
 * Solicitações explícitas ao conhecimento não devem depender da escolha do modelo.
 * Perguntas comuns continuam com tool_choice automático.
 */
export function shouldForceKnowledgeTool(message, { products } = {}) {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;

  const mentionsKnowledge =
    /\bconhecimento\b/.test(normalized) ||
    /\bbase\s+(?:de\s+)?(?:dados|produtos|informacoes)\b/.test(normalized);
  const asksToSearch =
    /\b(?:consulte|consultar|consulta|pesquise|pesquisar|busque|buscar|procure|procurar|verifique|verificar)\b/.test(
      normalized,
    );
  const refusesSearch =
    /\b(?:nao|sem)\s+(?:consulte|consultar|pesquise|pesquisar|busque|buscar|procure|procurar|verifique|verificar)\b/.test(
      normalized,
    );

  if (refusesSearch) return false;
  if (mentionsKnowledge && asksToSearch) return true;

  const mentionsCatalogProduct = catalogProductNames(products).some((name) =>
    normalized.includes(name),
  );
  const asksForDetails =
    /\b(?:quero|gostaria)\s+(?:de\s+)?saber\s+(?:mais\s+)?sobre\b/.test(normalized) ||
    /\b(?:fale|fala|conte|explica|explique)\s+(?:mais\s+)?(?:sobre|do|da)\b/.test(normalized) ||
    /\b(?:informacoes?|detalhes?)\s+(?:sobre|do|da)\b/.test(normalized);
  const asksProductFact =
    /\b(?:produto|servico|perfume|preco|valor|custa|foto|imagem|video|estoque|disponivel|disponibilidade|descricao|caracteristicas?|beneficios?|modelo|tamanho|cor|fragrancia|fixacao)\b/.test(
      normalized,
    );

  return mentionsCatalogProduct || asksForDetails || asksProductFact;
}
