import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
});
