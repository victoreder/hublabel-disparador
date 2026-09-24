import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shouldForceKnowledgeTool } from '../src/inbound/agent/knowledgeIntent.js';

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
