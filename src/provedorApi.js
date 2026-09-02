/** Resolve provedor da conexão (evolution | uazapi | oficial). */
export function resolveProvedorApi(conexao) {
  if (!conexao) return 'evolution';
  if (conexao.apiOficial === true) return 'oficial';
  const provedor = String(conexao.provedorApi || '')
    .trim()
    .toLowerCase();
  if (provedor === 'uazapi' || provedor === 'oficial' || provedor === 'evolution') {
    return provedor;
  }
  return 'evolution';
}

export function isUazapiConexao(conexao) {
  return resolveProvedorApi(conexao) === 'uazapi';
}

export function isEvolutionConexao(conexao) {
  return resolveProvedorApi(conexao) === 'evolution';
}

export function randomInstanceSuffix(length = 6) {
  return Array.from({ length }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join('');
}

export function buildInstanceName(displayName) {
  const base = String(displayName || 'conexao')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'conexao';
  return `${base}-${randomInstanceSuffix()}`;
}
