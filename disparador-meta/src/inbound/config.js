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

/** Config do serviço inbound (webhooks Meta + Evolution). */
export function getInboundConfig() {
  return {
    port: optionalInt('INBOUND_PORT', 3090),
    eventsMetaPath: process.env.EVENTS_META_PATH?.trim() || '/backend/webhook-eventsmeta',
    evolutionWebhookPath:
      process.env.EVOLUTION_WEBHOOK_PATH?.trim() || '/webhook/agente-no-whatsapp',
    agentPollMs: optionalInt('AGENT_POLL_MS', 500),
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
    s3: {
      endpoint: required('S3_ENDPOINT'),
      region: process.env.S3_REGION?.trim() || 'us-east-1',
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      bucket: process.env.S3_BUCKET?.trim() || 'n8n',
      publicBaseUrl: required('S3_PUBLIC_BASE_URL').replace(/\/$/, ''),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    },
  };
}
