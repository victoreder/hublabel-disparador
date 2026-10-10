import { logger } from '../../logger.js';
import { supabase } from '../../supabase.js';

/**
 * White-label do sistema (nome, cor, telefone de suporte, logo, favicon).
 * Fica numa linha única (id=1) de SAAS_Personalizacao e é aplicada no servidor
 * ao servir cada tela — o HTML já sai personalizado, sem "piscar" no navegador.
 * Vídeos de ajuda continuam em SAAS_VideosAjuda (a tela de ajuda lê de lá).
 */
export const PERSONALIZACAO_TABLE = 'SAAS_Personalizacao';
const CACHE_TTL_MS = 30_000;

export const PERSONALIZACAO_PADRAO = Object.freeze({
  nome: 'Disparamator',
  cor: '25D366',
  telefoneSuporte: '5548984549300',
  logoUrl: null,
  faviconUrl: null,
});

let cache = null;
let cacheAt = 0;
let avisoTabelaAusente = false;

export function normalizarCorHex(value) {
  const hex = String(value ?? '').trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

export function corParaRgb(hex) {
  const clean = normalizarCorHex(hex);
  if (!clean) return null;
  const n = Number.parseInt(clean, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * O nome entra em HTML, atributos e strings JS das telas: aspas viram as
 * tipográficas e caracteres que quebram código são removidos.
 */
export function sanitizarNome(value) {
  const nome = String(value ?? '')
    .replace(/'/g, '’')
    .replace(/"/g, '”')
    .replace(/[^\p{L}\p{N}\s.,\-_&!()+:|’”]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return nome.slice(0, 80) || null;
}

export function sanitizarTelefone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 20) : null;
}

export function sanitizarUrl(value) {
  const url = String(value ?? '').trim().split('#')[0];
  if (!/^https?:\/\/[^\s"'<>`\\]+$/i.test(url)) return null;
  return url;
}

function rowToPersonalizacao(row) {
  return {
    nome: sanitizarNome(row?.nome) ?? PERSONALIZACAO_PADRAO.nome,
    cor: normalizarCorHex(row?.cor) ?? PERSONALIZACAO_PADRAO.cor,
    telefoneSuporte: sanitizarTelefone(row?.telefoneSuporte) ?? PERSONALIZACAO_PADRAO.telefoneSuporte,
    logoUrl: sanitizarUrl(row?.logoUrl),
    faviconUrl: sanitizarUrl(row?.faviconUrl),
    versao: row?.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}

export function invalidarPersonalizacao() {
  cache = null;
  cacheAt = 0;
}

export async function getPersonalizacao() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

  const { data, error } = await supabase
    .from(PERSONALIZACAO_TABLE)
    .select('nome, cor, "telefoneSuporte", "logoUrl", "faviconUrl", updated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    if (!avisoTabelaAusente) {
      avisoTabelaAusente = true;
      logger.warn('[personalizacao] falha ao ler SAAS_Personalizacao — usando padrão', {
        message: error.message,
      });
    }
    // Mantém o último valor bom (ou o padrão) até o próximo ciclo, para não
    // "despersonalizar" num erro transitório nem consultar o banco a cada tela.
    cache = cache ?? rowToPersonalizacao(null);
    cacheAt = Date.now();
    return cache;
  }

  avisoTabelaAusente = false;
  cache = rowToPersonalizacao(data);
  cacheAt = Date.now();
  return cache;
}

/**
 * Body enviado pela aba Personalização do admin (mesmo contrato do antigo
 * webhook n8n): corNova, nomeNova, logoNova, faviconeNova, telefoneSuporteNova.
 * Só grava os campos válidos que vieram preenchidos.
 */
export async function salvarPersonalizacao(body = {}) {
  const patch = {};
  const cor = normalizarCorHex(body.corNova ?? body.cor);
  const nome = sanitizarNome(body.nomeNova ?? body.nome);
  const telefone = sanitizarTelefone(body.telefoneSuporteNova ?? body.telefoneSuporte);
  const logo = sanitizarUrl(body.logoNova ?? body.logoUrl);
  const favicon = sanitizarUrl(body.faviconeNova ?? body.faviconUrl);

  if (cor) patch.cor = cor;
  if (nome) patch.nome = nome;
  if (telefone) patch.telefoneSuporte = telefone;
  if (logo) patch.logoUrl = logo;
  if (favicon) patch.faviconUrl = favicon;

  const { data, error } = await supabase
    .from(PERSONALIZACAO_TABLE)
    .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select('nome, cor, "telefoneSuporte", "logoUrl", "faviconUrl", updated_at')
    .single();

  if (error) throw new Error(`Erro ao salvar personalização: ${error.message}`);

  invalidarPersonalizacao();
  return rowToPersonalizacao(data);
}
