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

export function supportsCustomTemperature(model) {
  const m = String(model || '').toLowerCase();
  return !(
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  );
}
