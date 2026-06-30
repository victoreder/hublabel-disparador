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

/** Paths fixos na raiz do BACK_URL (/{slug}). */
export const WEBHOOK_PATHS = {
  eventsMeta: 'eventsmeta',
  evolution: 'webhook-mensagens',
  metaToken: 'meta-token',
  metaCriarTemplate: 'meta-criar-template',
  metaExcluirTemplate: 'meta-excluir-template',
  metaPerfil: 'meta-perfil',
  metaRenovarToken: 'meta-renovar-token',
  metaRenovarTokenCron: 'meta-renovar-token-cron',
  calcularToken: 'calcular-token',
};

/**
 * URL base (só origem).
 * Ex.: https://webhook2.victoreder.com.br ou https://app.viziom.com.br
 */
export function parseBackUrl() {
  const raw = required('BACK_URL');
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);

  return {
    backUrl: url.origin,
    host: url.hostname,
  };
}

export function buildWebhookExpressPath(slug) {
  return `/${slug.replace(/^\/+/, '')}`;
}

export function buildPublicWebhookUrl(backUrl, slug) {
  const base = backUrl.replace(/\/$/, '');
  return `${base}/${slug.replace(/^\/+/, '')}`;
}

/** Config do serviço inbound (webhooks Meta + Evolution). */
export function getInboundConfig() {
  const back = parseBackUrl();
  const p = WEBHOOK_PATHS;

  const expressPath = (slug) => buildWebhookExpressPath(slug);
  const publicUrl = (slug) => buildPublicWebhookUrl(back.backUrl, slug);

  return {
    port: optionalInt('INBOUND_PORT', 3090),
    backUrl: back.backUrl,
    backHost: back.host,
    webhookPaths: p,
    eventsMetaPath: expressPath(p.eventsMeta),
    evolutionWebhookPath: expressPath(p.evolution),
    agentPollMs: optionalInt('AGENT_POLL_MS', 500),
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
    metaApiPaths: {
      token: expressPath(p.metaToken),
      criarTemplate: expressPath(p.metaCriarTemplate),
      excluirTemplate: expressPath(p.metaExcluirTemplate),
      perfil: expressPath(p.metaPerfil),
      renovarToken: expressPath(p.metaRenovarToken),
      renovarTokenCron: expressPath(p.metaRenovarTokenCron),
    },
    publicWebhookUrls: {
      eventsMeta: publicUrl(p.eventsMeta),
      evolution: publicUrl(p.evolution),
      metaToken: publicUrl(p.metaToken),
      metaCriarTemplate: publicUrl(p.metaCriarTemplate),
      metaExcluirTemplate: publicUrl(p.metaExcluirTemplate),
      metaPerfil: publicUrl(p.metaPerfil),
      metaRenovarToken: publicUrl(p.metaRenovarToken),
      metaRenovarTokenCron: publicUrl(p.metaRenovarTokenCron),
      calcularToken: publicUrl(p.calcularToken),
    },
    calcularTokenUrl: publicUrl(p.calcularToken),
    tokenRenewalCronHour: 3,
    tokenRenewalCronMinute: 0,
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
