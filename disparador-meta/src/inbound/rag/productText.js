function firstPresent(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value != null && value !== '') return value;
  }
  return null;
}

function displayValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim() || null;
}

/**
 * Converte os campos separados de um produto em um documento textual completo.
 * Os rótulos ajudam a busca semântica a relacionar perguntas a preço, estoque etc.
 */
export function resolveProductContent(body = {}) {
  const nested =
    body.produto && typeof body.produto === 'object' && !Array.isArray(body.produto)
      ? body.produto
      : null;
  const source = nested ? { ...body, ...nested } : body;
  const kind = String(
    body.tipoConhecimento ?? body.tipo_conhecimento ?? body.categoria ?? body.tipo ?? '',
  ).toLowerCase();
  const hasProductMarker =
    nested != null ||
    body.produto != null ||
    /produto|product/.test(kind) ||
    firstPresent(source, ['preco', 'preço', 'price', 'valor', 'valorVenda']) != null;

  if (!hasProductMarker) return null;

  const fields = [
    ['Nome do produto', ['nome', 'name', 'titulo', 'title']],
    ['Descrição', ['descricao', 'descrição', 'description', 'conteudo', 'text']],
    ['Preço', ['preco', 'preço', 'price', 'valor', 'valorVenda']],
    ['Código/SKU', ['sku', 'codigo', 'código', 'code']],
    ['Marca', ['marca', 'brand']],
    ['Categoria', ['categoria', 'category']],
    ['Disponibilidade', ['disponibilidade', 'estoque', 'stock']],
    ['Link do produto', ['url', 'link', 'productUrl', 'urlProduto']],
  ];
  const lines = ['Tipo de conhecimento: produto'];
  const consumed = new Set();

  for (const [label, keys] of fields) {
    const value = displayValue(firstPresent(source, keys));
    if (!value) continue;
    lines.push(`${label}: ${value}`);
    keys.forEach((key) => consumed.add(key));
  }

  if (nested) {
    const extras = Object.entries(nested).filter(
      ([key, value]) =>
        !consumed.has(key) &&
        !['midias', 'medias', 'media', 'fotos', 'imagens', 'images'].includes(key) &&
        value != null &&
        value !== '',
    );
    if (extras.length) {
      lines.push('Outras informações:');
      for (const [key, value] of extras) lines.push(`${key}: ${displayValue(value)}`);
    }
  }

  return lines.length > 1 ? lines.join('\n') : null;
}
