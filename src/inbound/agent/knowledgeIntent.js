function normalizeMessage(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Solicitações explícitas ao conhecimento não devem depender da escolha do modelo.
 * Perguntas comuns continuam com tool_choice automático.
 */
export function shouldForceKnowledgeTool(message) {
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

  return mentionsKnowledge && asksToSearch && !refusesSearch;
}
