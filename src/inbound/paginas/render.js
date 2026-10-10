import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { buildAuthScript, injectAuthScript } from './authScript.js';
import { corParaRgb, getPersonalizacao } from './personalizacao.js';

/**
 * Procura public/pages subindo a partir deste arquivo. Na imagem distribuída o código vira um
 * bundle em src/inbound.js, então a profundidade do caminho relativo muda.
 */
function findPagesDir() {
  let dir = new URL('./', import.meta.url);
  for (let i = 0; i < 6; i += 1) {
    const candidate = new URL('public/pages/', dir);
    if (existsSync(candidate)) return candidate;
    dir = new URL('../', dir);
  }
  return new URL('../../../public/pages/', import.meta.url);
}

export const PAGES_DIR = findPagesDir();

/** Páginas que não são telas do sistema (servidas por rotas próprias). */
const PAGINAS_ESPECIAIS = new Set(['pv']);

let templates = null;

/** Carrega public/pages/*.html em memória (uma vez). Slug = nome do arquivo. */
export function loadPageTemplates() {
  if (templates) return templates;
  templates = new Map();
  for (const file of readdirSync(PAGES_DIR)) {
    if (!file.endsWith('.html')) continue;
    const slug = file.slice(0, -'.html'.length);
    if (PAGINAS_ESPECIAIS.has(slug)) continue;
    templates.set(slug, readFileSync(new URL(file, PAGES_DIR), 'utf8'));
  }
  return templates;
}

export function readDefaultSalesPage() {
  return readFileSync(new URL('pv.html', PAGES_DIR), 'utf8');
}

function withVersion(url, versao) {
  if (!versao) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${versao}`;
}

/** Valores de todos os placeholders das telas (env da stack + personalização). */
export function buildReplacements({ inboundConfig, personalizacao }) {
  const supabaseUrl = config.supabaseUrl;
  const back = new URL(inboundConfig.backUrl);
  const storage = `${supabaseUrl}/storage/v1/object/public/arquivos`;

  return {
    __HUB_LOGO_URL__: withVersion(
      personalizacao.logoUrl || `${storage}/LOGO%20PRINCIPAL.png`,
      personalizacao.versao,
    ),
    __HUB_FAVICON_URL__: withVersion(
      personalizacao.faviconUrl || `${storage}/FAVICON.png`,
      personalizacao.versao,
    ),
    __HUB_SUPABASE_URL__: supabaseUrl,
    __HUB_SUPABASE_ANON_KEY__: process.env.SUPABASE_ANON_KEY?.trim() || '',
    __HUB_BACK_URL__: inboundConfig.backUrl,
    __HUB_BACK_ORIGIN__: back.origin,
    __HUB_BACK_HOST__: back.host,
    __HUB_EVOLUTION_URL__: inboundConfig.evolutionBaseUrl,
    __HUB_COR_RGB__: corParaRgb(personalizacao.cor),
    __HUB_COR__: personalizacao.cor,
    __HUB_NOME__: personalizacao.nome,
    __HUB_TELEFONE_SUPORTE__: personalizacao.telefoneSuporte,
  };
}

export function applyReplacements(template, replacements) {
  let out = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    out = out.split(placeholder).join(value);
  }
  return out;
}

const rendered = new Map();

/** HTML final de uma tela, com cache por combinação de valores. */
export async function renderPage(slug, inboundConfig) {
  const template = loadPageTemplates().get(slug);
  if (template == null) return null;

  const personalizacao = await getPersonalizacao();
  const replacements = buildReplacements({ inboundConfig, personalizacao });
  const key = JSON.stringify(replacements);

  const cached = rendered.get(slug);
  if (cached?.key === key) return cached;

  const html = injectAuthScript(
    applyReplacements(template, replacements),
    buildAuthScript(inboundConfig.backUrl),
  );
  const body = Buffer.from(html, 'utf8');
  const entry = {
    key,
    body,
    gzip: gzipSync(body),
    etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
  };
  rendered.set(slug, entry);
  return entry;
}

export function sendHtml(req, res, entry) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Sempre revalida: personalização muda sem deploy, o ETag evita baixar de novo.
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', entry.etag);
  res.set('Vary', 'Accept-Encoding');

  if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();

  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.set('Content-Encoding', 'gzip');
    return res.status(200).end(entry.gzip);
  }
  return res.status(200).end(entry.body);
}

export function warnIfAnonKeyMissing() {
  if (!process.env.SUPABASE_ANON_KEY?.trim()) {
    logger.error(
      '[paginas] SUPABASE_ANON_KEY ausente — as telas carregam, mas o login não funciona. Defina a anon key na stack.',
    );
  }
}
