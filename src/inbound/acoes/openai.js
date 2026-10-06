import { supabase } from '../../supabase.js';
import { HttpError } from '../meta/httpError.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

/** Mesma fonte do n8n: SAAS_Config_IA id=1, coluna apikey. */
export async function fetchConfigIaApiKey() {
  const { data, error } = await supabase
    .from('SAAS_Config_IA')
    .select('apikey')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new HttpError(`Erro ao buscar SAAS_Config_IA: ${error.message}`, 500);
  const apikey = String(data?.apikey ?? '').trim();
  if (!apikey) throw new HttpError('Chave OpenAI não configurada (SAAS_Config_IA id=1).', 400);
  return apikey;
}

export async function openAiChatCompletions({ apiKey, body }) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

function parseSseEvent(block) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  return JSON.parse(data);
}

/**
 * Responses API em streaming: os cabeçalhos chegam na hora, então respostas
 * longas (ex.: reescrever a página de vendas inteira) não esbarram no timeout
 * de cabeçalho do fetch. Retorna o texto final concatenado.
 */
export async function openAiResponsesText({ apiKey, body, timeoutMs = 15 * 60_000 }) {
  const res = await fetch(`${OPENAI_BASE}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(`OpenAI ${res.status}: ${detail.slice(0, 500)}`, 502);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completedText = null;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const event = parseSseEvent(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (!event) continue;

      if (event.type === 'response.output_text.delta') {
        text += event.delta ?? '';
      } else if (event.type === 'response.completed') {
        completedText = extractOutputText(event.response);
      } else if (event.type === 'response.failed' || event.type === 'error') {
        const message =
          event.response?.error?.message || event.error?.message || event.message || 'falha na OpenAI';
        throw new HttpError(`OpenAI: ${message}`, 502);
      }
    }
  }

  return completedText || text;
}

export function extractOutputText(response) {
  const parts = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}
