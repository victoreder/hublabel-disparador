import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKnowledgeContext,
  selectAgentProductDocuments,
} from '../src/inbound/agent/knowledgeContext.js';
import { appendMediaLinksToText, normalizeMediaLinks } from '../src/inbound/rag/mediaLinks.js';
import { resolveProductContent } from '../src/inbound/rag/productText.js';

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
