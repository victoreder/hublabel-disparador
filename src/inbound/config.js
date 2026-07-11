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

/**
 * Slugs fixos — sem prefixo. O prefixo vem do path do BACK_URL (ex.: /webhook).
 * URL pública: {BACK_URL}/{slug} → https://dominio/webhook/meta-token
 * Rota Express: /{slug} → /meta-token (Traefik remove o prefixo do BACK_URL antes de encaminhar)
 */
export const WEBHOOK_PATHS = {
  eventsMeta: 'eventsmeta',
  evolution: 'agente-no-whatsapp',
  evolutionLegacy: 'webhook-mensagens',
  metaToken: 'meta-token',
  metaCriarTemplate: 'meta-criar-template',
  metaExcluirTemplate: 'meta-excluir-template',
  metaPerfil: 'meta-perfil',
  metaRenovarToken: 'meta-renovar-token',
  metaRenovarTokenCron: 'meta-renovar-token-cron',
  calcularToken: 'calcular-token',
};

const RAG_INSERIR_CONHECIMENTO_SUFFIX = 'inserir-conhecimento';
const SYNC_TEMPLATES_SUFFIX = 'sincronizar-templates';

/**
 * BACK_URL = origem + path opcional (ex.: https://webhook2.victoreder.com.br/webhook).
 * basePath vazio quando BACK_URL não tem path (rotas na raiz do domínio).
 */
export function normalizeBasePath(pathname) {
  if (!pathname || pathname === '/') return '';
  return `/${pathname.replace(/^\/+|\/+$/g, '')}`;
}

export function parseBackUrl() {
  const raw = required('BACK_URL');
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  const basePath = normalizeBasePath(url.pathname);
  const backUrl = `${url.origin}${basePath}`;

  return {
    origin: url.origin,
    backUrl,
    basePath,
    host: url.hostname,
  };
}

/** Rota interna do Express — sempre /{slug}, sem prefixo do BACK_URL. */
export function buildWebhookExpressPath(slug) {
  return `/${slug.replace(/^\/+/, '')}`;
}

/** Sub-rota sob slug já exposto no Traefik (ex.: /agente-no-whatsapp/inserir-conhecimento). */
export function buildWebhookSubPath(parentSlug, childSlug) {
  const parent = String(parentSlug).replace(/^\/+|\/+$/g, '');
  const child = String(childSlug).replace(/^\/+|\/+$/g, '');
  return `/${parent}/${child}`;
}

/** URL pública exposta ao front / Meta — BACK_URL + slug. */
export function buildPublicWebhookUrl(backUrl, slug) {
  const base = backUrl.replace(/\/$/, '');
  return `${base}/${slug.replace(/^\/+/, '')}`;
}

/** Path externo no Traefik (antes do StripPrefix): basePath + slug. */
export function buildTraefikExternalPath(basePath, slug) {
  const cleanSlug = slug.replace(/^\/+/, '');
  if (!basePath) return `/${cleanSlug}`;
  return `${basePath}/${cleanSlug}`;
}

/** Config do serviço inbound (webhooks Meta + Evolution). */
export function getInboundConfig() {
  const back = parseBackUrl();
  const p = WEBHOOK_PATHS;

  const expressPath = (slug) => buildWebhookExpressPath(slug);
  const publicUrl = (slug) => buildPublicWebhookUrl(back.backUrl, slug);
  const traefikPath = (slug) => buildTraefikExternalPath(back.basePath, slug);

  return {
    port: optionalInt('INBOUND_PORT', 3090),
    backUrl: back.backUrl,
    basePath: back.basePath,
    traefikStripPrefix: back.basePath || null,
    backHost: back.host,
    webhookPaths: p,
    eventsMetaPath: expressPath(p.eventsMeta),
    evolutionWebhookPath: expressPath(p.evolution),
    evolutionWebhookLegacyPath: expressPath(p.evolutionLegacy),
    agentPollMs: optionalInt('AGENT_POLL_MS', 500),
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v25.0',
    ragPath: buildWebhookSubPath(p.evolution, RAG_INSERIR_CONHECIMENTO_SUFFIX),
    syncTemplatesPath: buildWebhookSubPath(p.evolution, SYNC_TEMPLATES_SUFFIX),
    metaApiPaths: {
      token: expressPath(p.metaToken),
      criarTemplate: expressPath(p.metaCriarTemplate),
      excluirTemplate: expressPath(p.metaExcluirTemplate),
      perfil: expressPath(p.metaPerfil),
      renovarToken: expressPath(p.metaRenovarToken),
      renovarTokenCron: expressPath(p.metaRenovarTokenCron),
    },
    traefikPaths: {
      health: traefikPath('health'),
      eventsMeta: traefikPath(p.eventsMeta),
      evolution: traefikPath(p.evolution),
      evolutionLegacy: traefikPath(p.evolutionLegacy),
      metaToken: traefikPath(p.metaToken),
      metaCriarTemplate: traefikPath(p.metaCriarTemplate),
      metaExcluirTemplate: traefikPath(p.metaExcluirTemplate),
      metaPerfil: traefikPath(p.metaPerfil),
      metaRenovarToken: traefikPath(p.metaRenovarToken),
      metaRenovarTokenCron: traefikPath(p.metaRenovarTokenCron),
    },
    publicWebhookUrls: {
      eventsMeta: publicUrl(p.eventsMeta),
      evolution: publicUrl(p.evolution),
      evolutionLegacy: publicUrl(p.evolutionLegacy),
      metaToken: publicUrl(p.metaToken),
      metaCriarTemplate: publicUrl(p.metaCriarTemplate),
      metaExcluirTemplate: publicUrl(p.metaExcluirTemplate),
      metaPerfil: publicUrl(p.metaPerfil),
      metaRenovarToken: publicUrl(p.metaRenovarToken),
      metaRenovarTokenCron: publicUrl(p.metaRenovarTokenCron),
      calcularToken: publicUrl(p.calcularToken),
      inserirConhecimento: publicUrl(p.evolution),
      inserirConhecimentoLegacy: buildPublicWebhookUrl(
        back.backUrl,
        `${p.evolution}/${RAG_INSERIR_CONHECIMENTO_SUFFIX}`,
      ),
      sincronizarTemplates: publicUrl(p.evolution),
      sincronizarTemplatesLegacy: buildPublicWebhookUrl(
        back.backUrl,
        `${p.evolution}/${SYNC_TEMPLATES_SUFFIX}`,
      ),
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
