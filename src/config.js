function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value.trim();
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

export const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
  port: optionalInt('PORT', 3080),
  sendIntervalMs: optionalInt('SEND_INTERVAL_MS', 2000),
  pollIdleMs: optionalInt('POLL_IDLE_MS', 2000),
  maxRetries: optionalInt('MAX_RETRIES', 3),
};
