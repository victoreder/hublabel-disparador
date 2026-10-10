import { supabase } from '../../supabase.js';
import { HttpError } from '../meta/httpError.js';
import { readDefaultSalesPage } from './render.js';

/**
 * Página de vendas (/pv). O HTML padrão está em public/pages/pv.html; ao
 * "criar" ele é copiado para SAAS_PaginaVendas (id=1) e as edições feitas no
 * admin passam a valer de lá — assim sobrevivem a cada novo deploy da imagem.
 */
const TABLE = 'SAAS_PaginaVendas';
const ID = 1;
const CACHE_TTL_MS = 30_000;

let cache;
let cacheAt = 0;

function invalidar() {
  cache = undefined;
  cacheAt = 0;
}

export async function buscarPaginaVendas() {
  if (cache !== undefined && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const { data, error } = await supabase.from(TABLE).select('id, html, updated_at').eq('id', ID).maybeSingle();
  if (error) throw new HttpError(`Erro ao buscar ${TABLE}: ${error.message}`, 500);
  cache = data?.html ? data : null;
  cacheAt = Date.now();
  return cache;
}

export async function criarPaginaVendas() {
  const atual = await buscarPaginaVendas();
  if (atual) return atual;

  const { data, error } = await supabase
    .from(TABLE)
    .upsert({ id: ID, html: readDefaultSalesPage(), updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select('id, html, updated_at')
    .single();
  if (error) throw new HttpError(`Erro ao criar página de vendas: ${error.message}`, 500);
  invalidar();
  return data;
}

export async function salvarPaginaVendas(html) {
  const conteudo = String(html ?? '');
  if (!conteudo.trim()) throw new HttpError('html é obrigatório', 400);

  const { data, error } = await supabase
    .from(TABLE)
    .upsert({ id: ID, html: conteudo, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select('id, updated_at')
    .single();
  if (error) throw new HttpError(`Erro ao salvar página de vendas: ${error.message}`, 500);
  invalidar();
  return data;
}
