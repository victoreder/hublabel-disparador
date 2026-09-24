import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKnowledgeContext,
  selectAgentProductDocuments,
} from '../src/inbound/agent/knowledgeContext.js';
import { rankKnowledgeDocuments } from '../src/inbound/agent/knowledgeRanking.js';
import { appendMediaLinksToText, normalizeMediaLinks } from '../src/inbound/rag/mediaLinks.js';
import { resolveProductContent } from '../src/inbound/rag/productText.js';
import {
  materializeProductMedia,
  mergeAgentProductIntoBody,
  replaceAgentProduct,
} from '../src/inbound/rag/productMediaUpload.js';

test('normaliza várias imagens e vídeos enviados como array', () => {
  const media = normalizeMediaLinks({
    midias: [
      {
        id: 'foto-frente',
        tipo: 'imagem',
        url: 'https://cdn.exemplo.com/produtos/1/frente.webp',
        descricao: 'Vista frontal',
        ordem: 2,
      },
      {
        id: 'demonstracao',
        tipo: 'video',
        url: 'https://cdn.exemplo.com/produtos/1/demo.mp4',
        ordem: 1,
      },
    ],
  });

  assert.equal(media.length, 2);
  assert.equal(media[0].id, 'demonstracao');
  assert.equal(media[0].tipo, 'video');
  assert.equal(media[1].tipo, 'imagem');
});

test('aceita midias como JSON string em multipart/form-data', () => {
  const media = normalizeMediaLinks({
    midias: JSON.stringify([
      'https://cdn.exemplo.com/produtos/2/a.jpg',
      'https://cdn.exemplo.com/produtos/2/b.webm',
    ]),
  });

  assert.deepEqual(
    media.map((item) => item.tipo),
    ['imagem', 'video'],
  );
});

test('remove links duplicados', () => {
  const media = normalizeMediaLinks({
    midias: [
      'https://cdn.exemplo.com/produtos/3/a.png',
      'https://cdn.exemplo.com/produtos/3/a.png',
    ],
  });

  assert.equal(media.length, 1);
});

test('recusa protocolo diferente de HTTPS', () => {
  assert.throws(
    () => normalizeMediaLinks({ midias: ['http://cdn.exemplo.com/produtos/4/a.jpg'] }),
    /deve usar HTTPS/,
  );
});

test('exige tipo quando a extensão não permite inferência', () => {
  assert.throws(
    () => normalizeMediaLinks({ midias: ['https://cdn.exemplo.com/objeto-sem-extensao'] }),
    /tipo é obrigatório/,
  );
});

test('inclui links e descrições no texto vetorizado', () => {
  const media = normalizeMediaLinks({
    midias: [
      {
        tipo: 'imagem',
        url: 'https://cdn.exemplo.com/produtos/5/a.webp',
        descricao: 'Produto na cor azul',
      },
    ],
  });
  const text = appendMediaLinksToText('Nome: Produto exemplo', media);

  assert.match(text, /Nome: Produto exemplo/);
  assert.match(text, /Imagem 1: https:\/\/cdn\.exemplo\.com\/produtos\/5\/a\.webp/);
  assert.match(text, /Produto na cor azul/);
});

test('monta documento completo do produto sem perder preço', () => {
  const text = resolveProductContent({
    tipo: 'produto',
    nome: 'Perfume Árabe',
    descricao: 'Fragrância intensa e amadeirada',
    preco: 1500,
    sku: 'PA-1500',
  });

  assert.match(text, /Nome do produto: Perfume Árabe/);
  assert.match(text, /Descrição: Fragrância intensa e amadeirada/);
  assert.match(text, /Preço: 1500/);
  assert.match(text, /Código\/SKU: PA-1500/);
});

test('aceita fotos aninhadas no produto e publicUrl do storage', () => {
  const media = normalizeMediaLinks({
    produto: {
      nome: 'Perfume Árabe',
      fotos: [
        {
          publicUrl: 'https://cdn.exemplo.com/produtos/perfume-arabe/frente.jpg',
          descricao: 'Frasco visto de frente',
        },
      ],
    },
  });

  assert.equal(media.length, 1);
  assert.equal(media[0].tipo, 'imagem');
  assert.match(media[0].url, /frente\.jpg$/);
});

test('aceita produto serializado em JSON e aliases de URL usados pelo storage', () => {
  const media = normalizeMediaLinks({
    midias: [],
    produto: JSON.stringify({
      nome: 'Perfume Chinês',
      fotos: [
        {
          arquivo: {
            arquivoUrl: 'https://cdn.exemplo.com/produtos/perfume-chines/frente.webp',
            mimetype: 'image/webp',
          },
        },
        {
          urlArquivo: 'https://cdn.exemplo.com/produtos/perfume-chines/verso.jpg',
          tipoArquivo: 'imagem',
        },
      ],
    }),
  });

  assert.equal(media.length, 2);
  assert.equal(media[0].tipo, 'imagem');
  assert.match(media[0].url, /frente\.webp$/);
  assert.match(media[1].url, /verso\.jpg$/);
});

test('monta texto estruturado quando produto chega como JSON string', () => {
  const text = resolveProductContent({
    produto: JSON.stringify({
      nome: 'Perfume Chinês',
      descricao: 'Perfume ótimo para ocasiões especiais',
      preco: 100,
      imagens: ['https://cdn.exemplo.com/produtos/perfume-chines/foto.jpg'],
    }),
  });

  assert.match(text, /Nome do produto: Perfume Chinês/);
  assert.match(text, /Preço: 100/);
  assert.doesNotMatch(text, /cdn\.exemplo\.com/);
});

test('contexto recuperado orienta preço exato e envio da foto', () => {
  const context = buildKnowledgeContext([
    {
      content: [
        'Nome do produto: Perfume Árabe',
        'Preço: 1500',
        'Mídias do produto:',
        'Imagem 1: https://cdn.exemplo.com/perfume.jpg',
      ].join('\n'),
      metadata: { idUnico: 'produto-1' },
    },
  ]);

  assert.match(context, /Preço: 1500/);
  assert.match(context, /perfume\.jpg/);
  assert.match(context, /\(image\)/);
  assert.match(context, /não invente/i);
});

test('usa produtos salvos no agente como fallback enquanto o RAG não foi reindexado', () => {
  const documents = selectAgentProductDocuments(
    [
      { nome: 'Camiseta básica', preco: 99 },
      {
        nome: 'Perfume Árabe',
        preco: 1500,
        fotos: ['https://cdn.exemplo.com/perfume-frente.jpg'],
      },
    ],
    'Qual o preço e a foto do perfume árabe?',
    1,
  );

  assert.equal(documents.length, 1);
  assert.match(documents[0].content, /Perfume Árabe/);
  assert.match(documents[0].content, /1500/);
  assert.match(documents[0].content, /perfume-frente\.jpg/);
  assert.doesNotMatch(documents[0].content, /Camiseta básica/);
});

test('remove base64 e limita campos gigantes do produto antes de enviar ao modelo', () => {
  const documents = selectAgentProductDocuments(
    [
      {
        nome: 'Felino destruidor de lares',
        descricao: 'Um felino muito imponente',
        preco: 250000000,
        fotos: [
          {
            url: 'https://cdn.exemplo.com/felino.jpg',
            base64: 'A'.repeat(1_000_000),
          },
        ],
        arquivoBase64: 'B'.repeat(1_000_000),
      },
    ],
    'quais animais disponíveis?',
  );

  assert.equal(documents.length, 1);
  assert.match(documents[0].content, /Felino destruidor de lares/);
  assert.match(documents[0].content, /https:\/\/cdn\.exemplo\.com\/felino\.jpg/);
  assert.doesNotMatch(documents[0].content, /arquivoBase64|A{100}|B{100}/);
  assert.ok(documents[0].content.length < 10_000);
});

test('faz upload de foto base64 e substitui por URL pública antes do RAG', async () => {
  const uploads = [];
  const base64 = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('imagem-de-teste'),
  ]).toString('base64');
  const result = await materializeProductMedia(
    {
      produto: JSON.stringify({
        id: 'produto-1',
        nome: 'Perfume Árabe',
        fotos: [
          {
            base64,
            mimeType: 'image/png',
            descricao: 'Foto frontal',
          },
        ],
      }),
    },
    {
      upload: async (file) => {
        uploads.push(file);
        return { url: 'https://cdn.exemplo.com/rag/produtos/produto-1/foto.png' };
      },
    },
  );

  const product = JSON.parse(result.body.produto);
  assert.equal(uploads.length, 1);
  assert.equal(result.uploadedMedia.length, 1);
  assert.equal(product.fotos[0].url, 'https://cdn.exemplo.com/rag/produtos/produto-1/foto.png');
  assert.equal(product.fotos[0].tipo, 'imagem');
  assert.equal(product.fotos[0].descricao, 'Foto frontal');
  assert.equal('base64' in product.fotos[0], false);
  assert.deepEqual(
    normalizeMediaLinks(result.body).map((item) => item.url),
    ['https://cdn.exemplo.com/rag/produtos/produto-1/foto.png'],
  );
});

test('substitui base64 na coluna produtos preservando os demais campos', () => {
  const updated = replaceAgentProduct(
    [
      {
        id: 'produto-1',
        nome: 'Perfume Árabe',
        preco: 1500,
        campoLegado: 'preservar',
        fotos: [{ base64: 'muito-grande' }],
      },
    ],
    {
      id: 'produto-1',
      nome: 'Perfume Árabe',
      fotos: [{ url: 'https://cdn.exemplo.com/perfume.jpg', tipo: 'imagem' }],
    },
    'produto-1',
  );

  assert.equal(updated[0].campoLegado, 'preservar');
  assert.equal(updated[0].preco, 1500);
  assert.equal(updated[0].fotos[0].url, 'https://cdn.exemplo.com/perfume.jpg');
  assert.equal('base64' in updated[0].fotos[0], false);
});

test('recupera mídia do produto salvo quando a requisição envia apenas os campos básicos', () => {
  const body = mergeAgentProductIntoBody(
    {
      idUnico: 'produto-1',
      produto: {
        nome: 'Perfume Árabe',
        descricao: 'Descrição atualizada',
        preco: 1500,
      },
    },
    [
      {
        id: 'produto-1',
        nome: 'Perfume Árabe',
        descricao: 'Descrição antiga',
        preco: 1400,
        fotos: [{ base64: 'imagem-em-base64', mimeType: 'image/jpeg' }],
      },
    ],
    'produto-1',
  );

  assert.equal(body.produto.descricao, 'Descrição atualizada');
  assert.equal(body.produto.preco, 1500);
  assert.equal(body.produto.fotos[0].base64, 'imagem-em-base64');
});

test('prioriza o produto exato sobre conhecimento genérico de perfumes', () => {
  const documents = rankKnowledgeDocuments({
    query: 'quero saber mais sobre o perfume chines',
    limit: 2,
    vectorDocuments: [
      {
        content: 'Perfumes chineses podem ter fragrâncias florais, cítricas e amadeiradas.',
        metadata: { idUnico: 'geral' },
        similarity: 0.91,
        source: 'vector',
      },
    ],
    linkedDocuments: [
      {
        content: JSON.stringify({
          nome: 'Perfume Chines',
          descricao: 'perfume otimo para ocasioes especiais',
          preco: 100,
        }),
        metadata: { idUnico: 'produto' },
        similarity: null,
        source: 'linked',
      },
    ],
  });

  assert.equal(documents[0].metadata.idUnico, 'produto');
  assert.match(documents[0].content, /"preco":100/);
  assert.ok(documents[0].lexicalScore > documents[1].lexicalScore);
});
