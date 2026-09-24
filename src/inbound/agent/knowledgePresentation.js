const FOUND_INSTRUCTION = [
  'Use as fontes internas somente para compor a resposta ao cliente.',
  'Responda como um atendente humano, em linguagem natural, acolhedora e objetiva, normalmente em uma única mensagem curta.',
  'Nunca diga que encontrou registros, documentos, resultados, banco de dados, RAG ou conhecimento interno.',
  'Nunca mostre JSON, metadata, numeração de resultados nem rótulos crus como Nome:, Descrição: ou Preço:.',
  'Transforme nome, descrição e preço em frases naturais, mencionando apenas o que ajuda a responder à pergunta.',
  'Não acrescente informações gerais ou da internet que não estejam nas fontes.',
  'Se houver cadastros realmente diferentes ou dados conflitantes para o mesmo nome, apresente-os naturalmente como opções e faça uma pergunta curta para identificar qual deles o cliente deseja; não misture os dados.',
  'Quando houver um único produto, envie suas informações e logo depois suas mídias.',
  'Quando houver vários produtos, siga obrigatoriamente esta sequência: informações do produto 1, mídias do produto 1, informações do produto 2, mídias do produto 2, e assim por diante.',
  'Nunca reúna primeiro os textos de todos os produtos para só depois enviar todas as fotos.',
  'Identifique cada mídia com o nome do produto e use [nome do produto (image)](URL) ou [nome do produto (video)](URL), com dois enters entre cada bloco.',
].join(' ');

const KNOWLEDGE_SOURCE_MAX_CHARS = 8_000;
const KNOWLEDGE_PAYLOAD_MAX_CHARS = 24_000;
const KNOWLEDGE_MEDIA_MAX_ITEMS = 20;

const NOT_FOUND_INSTRUCTION = [
  'Responda ao cliente de forma natural e breve que você não possui essa informação cadastrada.',
  'Não mencione registros, documentos, banco de dados, RAG ou ferramenta e não invente uma resposta geral.',
].join(' ');

export const KNOWLEDGE_REWRITE_PROMPT = [
  'Reescreva a sua última resposta antes de enviá-la ao cliente.',
  'Use os mesmos fatos, mas fale como um atendente humano em uma única mensagem curta e conversacional.',
  'Não diga que encontrou registros ou resultados, não mostre JSON, não numere documentos e não use uma ficha com rótulos como Nome:, Descrição: ou Preço:.',
  'Se houver opções conflitantes, descreva-as naturalmente sem misturar os dados e pergunte qual delas interessa.',
  'Para vários produtos, mantenha cada descrição imediatamente junto de suas próprias mídias; nunca coloque todas as fotos no final.',
  'Retorne somente a nova resposta final.',
].join(' ');

function mediaFromMetadata(metadata) {
  if (!Array.isArray(metadata?.midias)) return [];
  return metadata.midias
    .slice(0, KNOWLEDGE_MEDIA_MAX_ITEMS)
    .map((item) => {
      const url = String(item?.url || '').trim();
      if (!/^https:\/\//i.test(url)) return null;
      return {
        tipo: String(item?.tipo || '').slice(0, 20),
        url: url.slice(0, 4_096),
        descricao: String(item?.descricao || '').slice(0, 500) || null,
      };
    })
    .filter(Boolean);
}

export function buildKnowledgeToolPayload(documents) {
  const docs = Array.isArray(documents) ? documents : [];
  const sources = [];
  let remainingChars = KNOWLEDGE_PAYLOAD_MAX_CHARS;
  for (const document of docs) {
    if (remainingChars < 256) break;
    const rawContent = String(document?.content || '').trim();
    if (!rawContent) continue;
    const maxChars = Math.min(KNOWLEDGE_SOURCE_MAX_CHARS, remainingChars);
    const informacao =
      rawContent.length > maxChars
        ? `${rawContent.slice(0, Math.max(0, maxChars - 24))}\n[conteúdo omitido]`
        : rawContent;
    sources.push({
      informacao,
      midias: mediaFromMetadata(document?.metadata),
    });
    remainingChars -= informacao.length;
  }

  return {
    instrucao_obrigatoria: sources.length ? FOUND_INSTRUCTION : NOT_FOUND_INSTRUCTION,
    encontrado: sources.length > 0,
    fontes_internas_nao_exibir_literalmente: sources,
  };
}

export function looksLikeRawKnowledgeDump(content) {
  const text = String(content || '').trim();
  if (!text) return false;
  if (/\bencontrei\s+(?:estes?\s+)?(?:registros?|resultados?|documentos?)\b/i.test(text)) {
    return true;
  }

  const rawLabels =
    text.match(/^\s*(?:[-*]|\d+[.)])?\s*(?:tipo|produto|nome|descri[cç][aã]o|pre[cç]o|valor)\s*:/gim) ?? [];
  if (rawLabels.length >= 2) return true;

  const jsonFields = text.match(/["'](?:nome|descricao|descrição|preco|preço)["']\s*:/gi) ?? [];
  return jsonFields.length >= 2;
}
