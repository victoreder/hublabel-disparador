const DESCRICAO_TTL_MS = 15 * 60 * 1000;

/** conversaId → descrições de imagem recentes (texto gerado por IA, não escrito pelo contato). */
const descricoesPorConversa = new Map();

function limparExpiradas(agora = Date.now()) {
  for (const [conversaId, itens] of descricoesPorConversa) {
    const validos = itens.filter((item) => item.expiraEm > agora);
    if (validos.length) descricoesPorConversa.set(conversaId, validos);
    else descricoesPorConversa.delete(conversaId);
  }
}

export function lembrarDescricaoImagem(conversaId, descricao) {
  const texto = String(descricao || '').trim();
  if (!conversaId || !texto) return;
  limparExpiradas();
  const itens = descricoesPorConversa.get(conversaId) ?? [];
  itens.push({ texto, expiraEm: Date.now() + DESCRICAO_TTL_MS });
  descricoesPorConversa.set(conversaId, itens);
}

/** Remove do texto as descrições de imagem da conversa, sobrando só o que o contato escreveu. */
export function removerDescricoesImagem(conversaId, text) {
  let resultado = String(text || '');
  limparExpiradas();
  for (const { texto } of descricoesPorConversa.get(conversaId) ?? []) {
    resultado = resultado.split(texto).join(' ');
  }
  return resultado.trim();
}
