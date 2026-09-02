import { fetchOpenAIApiKey } from '../../supabase.js';
import { buildPublicWebhookUrl, parseBackUrl, WEBHOOK_PATHS } from '../config.js';

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Variável ${name} deve ser um número inteiro`);
  return parsed;
}

let cachedOpenAiKey = null;
let cachedOpenAiKeyAt = 0;
const OPENAI_KEY_TTL_MS = 5 * 60 * 1000;

async function getCachedOpenAiKey() {
  const now = Date.now();
  if (cachedOpenAiKey && now - cachedOpenAiKeyAt < OPENAI_KEY_TTL_MS) {
    return cachedOpenAiKey;
  }
  cachedOpenAiKey = await fetchOpenAIApiKey();
  cachedOpenAiKeyAt = now;
  return cachedOpenAiKey;
}

export async function getAgentConfig() {
  const openaiApiKey = await getCachedOpenAiKey();

  return {
    openaiApiKey,
    redisUrl: process.env.REDIS_URL?.trim() || null,
    calcularTokenUrl: buildPublicWebhookUrl(parseBackUrl().backUrl, WEBHOOK_PATHS.calcularToken),
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
    whisperModel: process.env.OPENAI_WHISPER_MODEL?.trim() || 'whisper-1',
    visionModel: process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4o-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    maxToolRounds: optionalInt('AGENT_MAX_TOOL_ROUNDS', 6),
    /** Janela (ms) para cancelar geração no início quando chega nova mensagem */
    cancelWindowMs: optionalInt('AGENT_CANCEL_WINDOW_MS', 1500),
    pendingAnalysisModel: process.env.AGENT_PENDING_ANALYSIS_MODEL?.trim() || 'gpt-4o-mini',
    /** Delay Evolution sendText (ms). Default 300 — antes era 1000 fixo. */
    evolutionSendDelayMs: optionalInt('AGENT_EVOLUTION_SEND_DELAY_MS', 300),
    /** TTL (s) do cache Redis do histórico do agente. Default 48h. */
    historyCacheTtlSec: optionalInt('AGENT_HISTORY_CACHE_TTL_SEC', 48 * 60 * 60),
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
