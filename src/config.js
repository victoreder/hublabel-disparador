function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value.trim();
}

function detectSupabaseKeyType(key) {
  if (key.startsWith('eyJ')) return 'legacy_jwt';
  if (key.startsWith('sb_secret_')) return 'sb_secret';
  if (key.startsWith('sb_publishable_')) return 'sb_publishable';
  return 'unknown';
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Variável ${name} deve ser um número inteiro`);
  }
  return parsed;
}

const supabaseServiceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
const supabaseKeyType = detectSupabaseKeyType(supabaseServiceRoleKey);

/** Config do disparador Meta (API Oficial). */
export const config = {
  supabaseUrl: required('SUPABASE_URL').replace(/\/$/, ''),
  supabaseServiceRoleKey,
  supabaseKeyType,
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
  port: optionalInt('PORT', 3080),
  sendIntervalMs: optionalInt('SEND_INTERVAL_MS', 2000),
  pollIdleMs: optionalInt('POLL_IDLE_MS', 2000),
  maxRetries: optionalInt('MAX_RETRIES', 3),
};

/** Config do disparador Evolution (Individual + Grupos). */
export function getEvolutionConfig() {
  return {
    evolutionBaseUrl: required('EVOLUTION_BASE_URL').replace(/\/+$/, ''),
    evolutionApiKey: required('EVOLUTION_API_KEY'),
    intervalMs: 60_000,
    maxRetries: 3,
    retryDelayMs: 5000,
  };
}
