function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Variável ${name} deve ser um número inteiro`);
  return parsed;
}

export function getAgentConfig(configIA) {
  const tipoIA = configIA?.tipoIA?.trim() || 'openai';
  const openaiApiKey = configIA?.apikey?.trim();

  if (tipoIA !== 'openai') {
    throw new Error(`tipoIA "${tipoIA}" ainda não suportado em SAAS_Config_IA`);
  }
  if (!openaiApiKey) {
    throw new Error('Configure apikey em SAAS_Config_IA (id=1).');
  }

  return {
    tipoIA,
    openaiApiKey,
    redisUrl: process.env.REDIS_URL?.trim() || null,
    calcularTokenUrl: process.env.CALCULAR_TOKEN_URL?.trim() || null,
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
