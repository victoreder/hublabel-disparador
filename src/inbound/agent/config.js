import { fetchOpenAIApiKey } from '../../supabase.js';
import { buildPublicWebhookUrl, parseBackUrl, WEBHOOK_PATHS } from '../config.js';

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Variável ${name} deve ser um número inteiro`);
  return parsed;
}

export async function getAgentConfig() {
  const openaiApiKey = await fetchOpenAIApiKey();

  return {
    openaiApiKey,
    redisUrl: process.env.REDIS_URL?.trim() || null,
    calcularTokenUrl: buildPublicWebhookUrl(parseBackUrl().backUrl, WEBHOOK_PATHS.calcularToken),
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
    whisperModel: process.env.OPENAI_WHISPER_MODEL?.trim() || 'whisper-1',
    visionModel: process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4o-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    maxToolRounds: optionalInt('AGENT_MAX_TOOL_ROUNDS', 6),
  };
}

export function computeMaxTokens(agente) {
  const creditos = Number(agente?.maxCreditos ?? 0);
  const modelo = String(agente?.modelo ?? '');
  let fator = 1000;
  if (modelo === 'gpt-5-mini') fator = 1000;
  else if (modelo === 'gpt-5') fator = 200;
  else if (modelo === 'gpt-5-pro') fator = Math.round(1000 / 60);
  return Math.max(256, Math.floor(creditos * fator));
}

/** Modelos novos (gpt-5 / o-series) exigem max_completion_tokens em vez de max_tokens. */
export function usesMaxCompletionTokens(model) {
  const m = String(model || '').toLowerCase();
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  );
}

export function applyMaxOutputTokens(body, model, maxTokens) {
  if (usesMaxCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }
  return body;
}
