const IMAGE_BLOCK_RE = /<imagem_do_contato>[\s\S]*?<\/imagem_do_contato>/g;

/**
 * Deixa claro para o agente que o texto é a imagem enviada pelo contato (e não algo
 * que ele digitou), mantendo a legenda quando houver.
 */
export function formatImageInput(descricao, legenda) {
  const bloco = [
    '<imagem_do_contato>',
    'O contato enviou uma imagem. Você não recebe o arquivo, mas esta é a descrição fiel do que aparece nela; responda como quem viu a imagem, sem dizer que não consegue ver:',
    descricao,
    '</imagem_do_contato>',
  ].join('\n');
  return legenda ? `${bloco}\nLegenda enviada com a imagem: ${legenda}` : bloco;
}

/** Remove descrições de imagem (texto gerado por IA, não escrito pelo contato). */
export function stripImageDescriptions(text) {
  return String(text || '').replace(IMAGE_BLOCK_RE, ' ').trim();
}
