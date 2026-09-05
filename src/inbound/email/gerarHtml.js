import { fetchOpenAIApiKey } from '../../supabase.js';
import { supportsCustomTemperature } from '../agent/config.js';
import { computeTokenCredits } from '../agent/tokens.js';
import { HttpError } from '../meta/httpError.js';

const MODELO_PADRAO = 'gpt-5';
const VAR_SISTEMA = ['nome', 'email', 'telefone', 'data', 'diadasemana', 'hora', 'mes', 'saudacao'];

export const PROMPT_EMAIL_HTML = [
  'Você é um especialista em e-mail marketing e HTML e-mail (Gmail, Outlook, Apple Mail).',
  'Gere UM e-mail em HTML pronto para envio, com visual limpo, hierarquia clara e boa UX.',
  '',
  '## HTML / CSS (obrigatório)',
  '- Documento completo: <!DOCTYPE html>, html, head (charset UTF-8 + viewport) e body.',
  '- Layout em tabelas (table/tr/td), largura máxima 600px, centralizado.',
  '- CSS somente inline. Sem <style> no head, sem JavaScript, sem formulários.',
  '- Sem position:absolute/fixed, sem flex/grid, sem web fonts externas.',
  '- Fonte web-safe: Arial, Helvetica, sans-serif.',
  '- Cores com contraste legível. Fundo do body + card interno com padding generoso.',
  '- Um CTA principal: link <a> com padding, cor de fundo e texto branco (botão).',
  '- Imagens só se as instruções pedirem URL real; sempre com alt e width.',
  '- Mobile: width="100%" no wrapper interno e max-width 600px.',
  '- Footer curto (por que recebeu / ignore se não quiser). Sem unsubscribe legal inventado.',
  '',
  '## Variáveis de personalização (obrigatório)',
  '- Nome, e-mail e telefone do destinatário: use EXATAMENTE <nome>, <email>, <telefone>.',
  '- Variáveis extras citadas nas instruções: mesmo formato <slug>, minúsculas, sem espaço (ex.: <empresa>, <produto>).',
  '- Também pode usar, se fizer sentido: <saudacao>, <data>, <diadasemana>, <hora>, <mes>.',
  '- NÃO substitua as variáveis por exemplos (não escreva "João" no lugar de <nome>).',
  '- NÃO use {{nome}}, ${nome}, [nome] nem %NOME%.',
  '- NÃO invente variável que não esteja nas instruções nem na lista acima.',
  '',
  '## Conteúdo',
  '- Siga as instruções do usuário (oferta, tom, marca, cores, CTA).',
  '- Português do Brasil, salvo se as instruções pedirem outro idioma.',
  '- Texto escaneável: título, 2–4 parágrafos curtos, um CTA.',
  '- Sem lorem ipsum se as instruções tiverem conteúdo real.',
  '- Não mencione que você é uma IA e não explique o HTML.',
  '- Não gere assunto, título de campanha nem texto fora do HTML.',
  '',
  '## Saída',
  'Responda APENAS JSON válido, sem markdown:',
  '{ "html": "<!DOCTYPE html>..." }',
].join('\n');

function slugCampo(nome) {
  return String(nome || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function extrairVariaveisInstrucao(texto) {
  const found = new Set();
  const re = /<([a-zA-ZÀ-ÿ0-9_]+)>/g;
  let m;
  while ((m = re.exec(String(texto || '')))) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

function buildUserPrompt({ instrucoes, camposPersonalizados }) {
  const extras = (camposPersonalizados || [])
    .map((c) => slugCampo(c.nome))
    .filter((s) => s && !VAR_SISTEMA.includes(s));
  const nasInstrucoes = extrairVariaveisInstrucao(instrucoes).filter((s) => !VAR_SISTEMA.includes(s));
  const variaveis = [...new Set([...extras, ...nasInstrucoes])];

  const linhas = [
    '## Instruções do usuário',
    String(instrucoes).trim(),
    '',
    '## Variáveis disponíveis',
    '- Sempre: <nome>, <email>, <telefone>',
    '- Data/hora do envio (se útil): <saudacao>, <data>, <diadasemana>, <hora>, <mes>',
  ];

  if (variaveis.length) {
    linhas.push(`- Extras desta conta/instrução: ${variaveis.map((v) => `<${v}>`).join(', ')}`);
  }

  linhas.push('', 'Gere o e-mail agora.');
  return linhas.join('\n');
}

function parseGeracao(content) {
  let raw = String(content || '').trim();
  raw = raw.replace(/^```(?:json|html)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(raw);
    const html = String(parsed.html || parsed.HTML || '').trim();
    if (html) return { html };
  } catch {
    // fallback: modelo devolveu HTML cru
  }

  const htmlMatch = raw.match(/<!DOCTYPE html[\s\S]+<\/html>/i) || raw.match(/<html[\s\S]+<\/html>/i);
  if (htmlMatch) {
    return { html: htmlMatch[0].trim() };
  }

  throw new HttpError('A IA não retornou um HTML de e-mail válido', 502);
}

export async function gerarEmailHtmlComIa({ instrucoes, camposPersonalizados, modelo }) {
  const openaiApiKey = await fetchOpenAIApiKey();
  const model = String(modelo || MODELO_PADRAO).trim() || MODELO_PADRAO;

  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PROMPT_EMAIL_HTML },
      { role: 'user', content: buildUserPrompt({ instrucoes, camposPersonalizados }) },
    ],
  };
  if (/^gpt-5|^o[1-4]/i.test(model)) {
    body.max_completion_tokens = 8000;
  } else {
    body.max_tokens = 4000;
  }
  if (supportsCustomTemperature(model)) body.temperature = 0.6;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new HttpError(json?.error?.message || 'Falha ao gerar e-mail com IA', response.status >= 400 ? response.status : 502);
    error.code = json?.error?.code;
    throw error;
  }

  const content = json.choices?.[0]?.message?.content;
  const gerado = parseGeracao(content);
  const totalTokens = Number(json.usage?.total_tokens ?? 0);
  const creditos = computeTokenCredits(totalTokens, model);

  return {
    html: gerado.html,
    modelo: model,
    totalTokens,
    creditos,
  };
}
