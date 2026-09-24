import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shouldForceKnowledgeTool } from '../src/inbound/agent/knowledgeIntent.js';
import {
  buildKnowledgeToolPayload,
  looksLikeRawKnowledgeDump,
} from '../src/inbound/agent/knowledgePresentation.js';

const openaiSource = await readFile(
  new URL('../src/inbound/agent/openai.js', import.meta.url),
  'utf8',
);
const toolsSource = await readFile(
  new URL('../src/inbound/agent/tools.js', import.meta.url),
  'utf8',
);

test('não consulta o RAG automaticamente antes da decisão do agente', () => {
  assert.doesNotMatch(openaiSource, /await\s+searchKnowledge\s*\(/);
  assert.doesNotMatch(openaiSource, /consulta automática ao conhecimento/i);
  assert.match(openaiSource, /searchKnowledge:\s*searchKnowledgeOnDemand/g);
});

test('orienta a ferramenta de conhecimento a ignorar saudações e testes', () => {
  assert.match(toolsSource, /Não use em saudações, mensagens de ativação ou teste/i);
  assert.match(toolsSource, /informação factual específica/i);
});

test('mantém o fallback de produtos dentro da ferramenta sob demanda', () => {
  assert.match(toolsSource, /if \(name === 'consultar_conhecimento'\)/);
  assert.match(toolsSource, /selectAgentProductDocuments\(agente\?\.produtos, args\.pergunta\)/);
  assert.match(toolsSource, /linkedDocuments:\s*savedProducts/);
});

test('obriga a consulta quando o usuário pede explicitamente pelo conhecimento', () => {
  assert.equal(
    shouldForceKnowledgeTool('consulte no seu conhecimento sobre o perfume chines'),
    true,
  );
  assert.equal(shouldForceKnowledgeTool('busque na base de conhecimento o preço'), true);
  assert.equal(shouldForceKnowledgeTool('pesquise no conhecimento sobre a CG 160'), true);
});

test('consulta RAG ao pedir detalhes de um produto sem dizer conhecimento', () => {
  assert.equal(shouldForceKnowledgeTool('quero saber mais sobre a Fumiara?'), true);
  assert.equal(
    shouldForceKnowledgeTool('A Fumiara é boa?', {
      products: [{ nome: 'Fumiara', descricao: 'Produto cadastrado' }],
    }),
    true,
  );
  assert.equal(shouldForceKnowledgeTool('qual o preço?'), true);
  assert.equal(shouldForceKnowledgeTool('tem fotos desse produto?'), true);
});

test('reconhece produto salvo como JSON string', () => {
  assert.equal(
    shouldForceKnowledgeTool('Me fale da Fumiara', {
      products: JSON.stringify([{ nome: 'Fumiara' }]),
    }),
    true,
  );
});

test('não obriga RAG em mensagens comuns ou quando o usuário recusa a consulta', () => {
  assert.equal(shouldForceKnowledgeTool('teste-ura'), false);
  assert.equal(shouldForceKnowledgeTool('bom dia, tudo bem?'), false);
  assert.equal(shouldForceKnowledgeTool('não consulte seu conhecimento agora'), false);
  assert.equal(shouldForceKnowledgeTool('quero falar com um atendente'), false);
});

test('força somente a primeira rodada e libera a resposta depois do resultado', () => {
  assert.match(openaiSource, /rounds === 1/);
  assert.match(openaiSource, /function: \{ name: 'consultar_conhecimento' \}/);
});

test('retorno do RAG exige resposta conversacional e oculta detalhes técnicos', () => {
  const payload = buildKnowledgeToolPayload([
    {
      content: JSON.stringify({
        nome: 'Perfume Árabe',
        descricao: 'Perfume de ótima fixação',
        preco: 1500,
      }),
      metadata: { midias: [{ tipo: 'imagem', url: 'https://cdn.exemplo.com/perfume.jpg' }] },
      similarity: 0.9,
    },
  ]);

  assert.equal(payload.encontrado, true);
  assert.match(payload.instrucao_obrigatoria, /atendente humano/i);
  assert.match(payload.instrucao_obrigatoria, /Nunca diga que encontrou registros/i);
  assert.match(payload.instrucao_obrigatoria, /Nunca mostre JSON/i);
  assert.match(payload.instrucao_obrigatoria, /frases naturais/i);
  assert.equal('quantidade' in payload, false);
  assert.equal('documentos' in payload, false);
  assert.equal(payload.fontes_internas_nao_exibir_literalmente[0].midias.length, 1);
});

test('limita o tamanho total do retorno da ferramenta de conhecimento', () => {
  const payload = buildKnowledgeToolPayload(
    Array.from({ length: 10 }, (_, index) => ({
      content: `Produto ${index}: ${'descrição longa '.repeat(20_000)}`,
      metadata: {
        midias: [
          { tipo: 'imagem', url: `https://cdn.exemplo.com/produto-${index}.jpg` },
          { tipo: 'imagem', url: `data:image/png;base64,${'A'.repeat(100_000)}` },
        ],
      },
    })),
  );
  const serialized = JSON.stringify(payload);

  assert.ok(serialized.length < 30_000);
  assert.doesNotMatch(serialized, /data:image|A{100}/);
  assert.ok(payload.fontes_internas_nao_exibir_literalmente.length <= 3);
});

test('ausência de conhecimento também gera resposta natural sem inventar', () => {
  const payload = buildKnowledgeToolPayload([]);

  assert.equal(payload.encontrado, false);
  assert.match(payload.instrucao_obrigatoria, /forma natural e breve/i);
  assert.match(payload.instrucao_obrigatoria, /não invente/i);
});

test('detecta despejo de registros e permite resposta conversacional', () => {
  assert.equal(
    looksLikeRawKnowledgeDump(
      'Encontrei estes registros:\n1)\nNome: Perfume Árabe\nDescrição: Boa fixação\nPreço: 1500',
    ),
    true,
  );
  assert.equal(
    looksLikeRawKnowledgeDump('{ "nome": "Perfume Árabe", "descricao": "Boa fixação" }'),
    true,
  );
  assert.equal(
    looksLikeRawKnowledgeDump(
      'O Perfume Árabe tem ótima fixação e custa R$ 1.500. Quer que eu envie as fotos?',
    ),
    false,
  );
});

test('reescreve resposta bruta no máximo uma vez sem consultar novamente', () => {
  assert.match(openaiSource, /looksLikeRawKnowledgeDump\(content\)/);
  assert.match(openaiSource, /knowledgeRewriteRequested = true/);
  assert.match(openaiSource, /body\.tool_choice = 'none'/);
});
