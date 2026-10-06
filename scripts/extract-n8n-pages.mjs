#!/usr/bin/env node
/**
 * Extrai as telas HTML do workflow n8n "[SAAS] HUBLABEL" para public/pages/<slug>.html.
 *
 * Uso: node scripts/extract-n8n-pages.mjs caminho/do/workflow.json
 *
 * Cada webhook GET que responde um nó HTML vira um arquivo com o mesmo slug
 * (ex.: GET /webhook/login → public/pages/login.html). Valores que mudam por
 * deploy/cliente viram placeholders, preenchidos em tempo de execução por
 * src/inbound/paginas/render.js:
 *
 *   __HUB_SUPABASE_URL__       → env SUPABASE_URL
 *   __HUB_SUPABASE_ANON_KEY__  → env SUPABASE_ANON_KEY
 *   __HUB_BACK_URL__           → env BACK_URL (ex.: https://dominio/webhook)
 *   __HUB_BACK_ORIGIN__        → origem do BACK_URL (ex.: https://dominio)
 *   __HUB_BACK_HOST__          → host do BACK_URL (ex.: dominio)
 *   __HUB_EVOLUTION_URL__      → env EVOLUTION_BASE_URL
 *   __HUB_NOME__, __HUB_COR__, __HUB_COR_RGB__, __HUB_TELEFONE_SUPORTE__,
 *   __HUB_LOGO_URL__, __HUB_FAVICON_URL__ → tabela SAAS_Personalizacao
 *
 * A página de vendas (/pv) sai do nó "CRIAR FLUXO" (workflow embutido).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'pages');

/** Valores gravados no export atual do n8n (padrão HubLabel). */
const ORIGINAL = {
  supabaseUrl: 'https://hxumiciyohbianfnzfyk.supabase.co',
  backUrl: 'https://webhook2.victoreder.com.br/webhook',
  backOrigin: 'https://webhook2.victoreder.com.br',
  evolutionUrl: 'https://evolution2.victoreder.com.br',
  nome: 'Disparamator',
  corHex: '25d366',
  corRgb: '37, 211, 102',
  telefoneSuporte: '5548984549300',
  logoPath: '/storage/v1/object/public/arquivos/LOGO%20PRINCIPAL.png',
  faviconPath: '/storage/v1/object/public/arquivos/FAVICON.png',
};

const ANON_KEY_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAnonJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload?.role === 'anon';
  } catch {
    return false;
  }
}

export function toTemplate(html) {
  let out = html;

  // Mais específico primeiro: URLs de logo/favicon contêm a URL do Supabase.
  out = out.replaceAll(`${ORIGINAL.supabaseUrl}${ORIGINAL.logoPath}`, '__HUB_LOGO_URL__');
  out = out.replaceAll(`${ORIGINAL.supabaseUrl}${ORIGINAL.faviconPath}`, '__HUB_FAVICON_URL__');
  out = out.replaceAll(ORIGINAL.supabaseUrl, '__HUB_SUPABASE_URL__');
  out = out.replaceAll(ORIGINAL.backUrl, '__HUB_BACK_URL__');
  out = out.replaceAll(ORIGINAL.backOrigin, '__HUB_BACK_ORIGIN__');
  out = out.replaceAll(ORIGINAL.evolutionUrl, '__HUB_EVOLUTION_URL__');
  out = out.replaceAll(new URL(ORIGINAL.backOrigin).host, '__HUB_BACK_HOST__');

  // Só a anon key (pública) vira placeholder; qualquer outro JWT é sinal de erro.
  out = out.replace(ANON_KEY_RE, (token) => {
    if (isAnonJwt(token)) return '__HUB_SUPABASE_ANON_KEY__';
    throw new Error('JWT que não é anon encontrado no HTML — revise antes de versionar.');
  });

  // Personalização (mesmas regras do antigo "personalizar-saas": cor hex sem
  // diferenciar maiúsculas; demais valores exatos).
  out = out.replace(new RegExp(escapeRegExp(ORIGINAL.corHex), 'gi'), '__HUB_COR__');
  out = out.replaceAll(ORIGINAL.corRgb, '__HUB_COR_RGB__');
  out = out.replaceAll(ORIGINAL.nome, '__HUB_NOME__');
  out = out.replaceAll(ORIGINAL.telefoneSuporte, '__HUB_TELEFONE_SUPORTE__');
  return out;
}

function buildPageMap(workflow) {
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const pages = [];

  for (const node of workflow.nodes) {
    if (!node.type.endsWith('.webhook')) continue;
    const method = node.parameters?.httpMethod || 'GET';
    if (method !== 'GET') continue;

    const next = workflow.connections?.[node.name]?.main?.[0]?.[0]?.node;
    const target = next ? byName.get(next) : null;
    if (!target?.type.endsWith('.html')) continue;

    pages.push({ slug: node.parameters.path, html: target.parameters.html });
  }
  return pages;
}

function extractSalesPage(workflow) {
  const node = workflow.nodes.find((n) => n.name === 'CRIAR FLUXO');
  if (!node) return null;
  const embedded = JSON.parse(node.parameters.workflowObject);
  const html = embedded.nodes.find((n) => n.type.endsWith('.html'));
  return html?.parameters?.html ?? null;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Uso: node scripts/extract-n8n-pages.mjs caminho/do/workflow.json');
    process.exit(1);
  }

  const workflow = JSON.parse(await readFile(input, 'utf8'));
  await mkdir(OUT_DIR, { recursive: true });

  const pages = buildPageMap(workflow);
  for (const page of pages) {
    const file = path.join(OUT_DIR, `${page.slug}.html`);
    await writeFile(file, toTemplate(page.html));
    console.log(`ok  /${page.slug}  →  public/pages/${page.slug}.html`);
  }

  const pv = extractSalesPage(workflow);
  if (pv) {
    // Página de vendas fica exatamente como está no n8n (sem placeholders).
    await writeFile(path.join(OUT_DIR, 'pv.html'), pv);
    console.log('ok  /pv  →  public/pages/pv.html (padrão da página de vendas)');
  }

  console.log(`\n${pages.length} telas extraídas.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
