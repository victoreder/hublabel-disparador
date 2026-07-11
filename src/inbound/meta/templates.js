import {
  deleteTemplateMetaRow,
  fetchConexaoApiOficialById,
  fetchTemplateMeta,
  insertTemplateMeta,
  upsertTemplatesMeta,
} from '../../supabase.js';
import { metaDelete, metaGet, metaPost } from './graph.js';
import { HttpError } from './httpError.js';
import { prepareTemplateComponentsForMeta } from './templateMedia.js';

const VALID_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

const TEMPLATE_LIST_FIELDS =
  'id,name,language,status,category,components,rejected_reason,quality_score';
const TEMPLATE_PAGE_LIMIT = 100;

function buildVariaveisCampos(body) {
  const fromBody =
    body?.variaveisCampos && typeof body.variaveisCampos === 'object' ? body.variaveisCampos : {};

  const variaveisCampos = {
    body: fromBody.body ?? {},
    header: fromBody.header ?? {},
    buttons: Array.isArray(fromBody.buttons) ? fromBody.buttons : [],
  };

  const headerMidia = body?.headerMidia ?? fromBody.headerMidia;
  if (headerMidia && typeof headerMidia === 'object') {
    variaveisCampos.headerMidia = headerMidia;
  }

  return variaveisCampos;
}

function buildComponentesSalvar(body, components) {
  return {
    componentes: components,
    variaveisCampos: buildVariaveisCampos(body),
  };
}

function assertConexaoApiOficial(conexao) {
  if (!conexao?.access_token || !conexao?.waba_id) {
    throw new HttpError('Conexao nao encontrada em SAAS_Conexoes.');
  }
  if (!conexao.apiOficial) {
    throw new HttpError('Conexao nao e API Oficial.');
  }
}

export async function handleCreateTemplate(body, { metaGraphApiVersion }) {
  const conexaoId = body.conexaoId || body.conexao_id;
  const name = body.name;
  const language = body.language || 'pt_BR';
  const category = body.category || 'MARKETING';
  const components = body.components;

  if (!conexaoId) throw new HttpError('Campo conexaoId obrigatorio.');
  if (!name || typeof name !== 'string') throw new HttpError('Campo name obrigatorio.');
  if (!Array.isArray(components) || !components.length) {
    throw new HttpError('Campo components obrigatorio (array).');
  }
  if (!VALID_CATEGORIES.includes(category)) {
    throw new HttpError('category deve ser MARKETING, UTILITY ou AUTHENTICATION.');
  }

  const conexao = await fetchConexaoApiOficialById(conexaoId);
  assertConexaoApiOficial(conexao);

  const metaComponents = await prepareTemplateComponentsForMeta({
    body,
    components,
    accessToken: conexao.access_token,
    metaGraphApiVersion,
  });

  const metaRes = await metaPost({
    version: metaGraphApiVersion,
    path: `${conexao.waba_id}/message_templates`,
    accessToken: conexao.access_token,
    body: { name, language, category, components: metaComponents },
  });

  const variaveisCampos = buildVariaveisCampos(body);
  const componentesSalvar = buildComponentesSalvar(body, components);

  const row = await insertTemplateMeta({
    conexaoId,
    wabaId: conexao.waba_id,
    nome: name,
    idioma: language,
    categoria: category,
    status: metaRes.status || 'PENDING',
    metaTemplateId: metaRes.id || null,
    componentes: componentesSalvar,
    variaveisCampos,
  });

  return {
    ok: true,
    templateId: row.id || null,
    conexaoId,
    nome: name,
    idioma: language,
    categoria: category,
    status: row.status || metaRes.status || 'PENDING',
    metaTemplateId: metaRes.id || null,
  };
}

export async function handleDeleteTemplate(body, { metaGraphApiVersion }) {
  const conexaoId = body.conexaoId || body.conexao_id;
  const templateId = body.templateId || body.template_id;

  if (!conexaoId) throw new HttpError('Campo conexaoId obrigatorio.');
  if (!templateId) throw new HttpError('Campo templateId obrigatorio.');

  const conexao = await fetchConexaoApiOficialById(conexaoId);
  assertConexaoApiOficial(conexao);

  const template = await fetchTemplateMeta(templateId);
  if (!template?.id) throw new HttpError('Template nao encontrado em SAAS_Templates_Meta.');
  if (String(template.conexaoId) !== String(conexaoId)) {
    throw new HttpError('Template nao pertence a esta conexao.');
  }

  let metaExcluido = false;
  let metaAviso = null;

  const qs = { name: template.nome };
  if (template.metaTemplateId) qs.hsm_id = template.metaTemplateId;

  try {
    const res = await metaDelete({
      version: metaGraphApiVersion,
      path: `${conexao.waba_id}/message_templates`,
      accessToken: conexao.access_token,
      query: qs,
    });

    if (res.success) {
      metaExcluido = true;
    } else {
      throw new HttpError('Falha ao excluir template na Meta.');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const notFound = /not found|does not exist|404|nao encontrado|não encontrado/i.test(msg);
    if (notFound) {
      metaAviso = msg || 'Template ja inexistente na Meta.';
    } else {
      throw error;
    }
  }

  await deleteTemplateMetaRow(templateId);

  return {
    ok: true,
    conexaoId,
    templateId: template.id,
    nome: template.nome,
    idioma: template.idioma,
    metaTemplateId: template.metaTemplateId,
    metaExcluido,
    metaAviso,
    supabaseExcluido: true,
  };
}

function extractQualityScore(qualityScore) {
  if (qualityScore == null) return null;
  if (typeof qualityScore === 'string') return qualityScore;
  if (typeof qualityScore === 'object') {
    return qualityScore.score ?? qualityScore.quality_score ?? null;
  }
  return null;
}

function mapMetaTemplateToRow(tpl, { conexaoId, wabaId, now }) {
  const components = Array.isArray(tpl.components) ? tpl.components : [];
  const rejected = tpl.rejected_reason;
  const motivoRejeicao =
    rejected && String(rejected).toUpperCase() !== 'NONE' ? String(rejected) : null;

  return {
    conexaoId,
    wabaId,
    metaTemplateId: tpl.id ? String(tpl.id) : null,
    nome: tpl.name,
    idioma: tpl.language || 'pt_BR',
    categoria: tpl.category || null,
    status: tpl.status || null,
    qualidade: extractQualityScore(tpl.quality_score),
    motivoRejeicao,
    componentes: { componentes: components },
    statusUpdatedAt: now,
    qualidadeUpdatedAt: now,
    categoriaUpdatedAt: now,
  };
}

async function fetchAllMessageTemplates({ wabaId, accessToken, metaGraphApiVersion }) {
  const templates = [];
  let after = null;

  for (;;) {
    const query = {
      fields: TEMPLATE_LIST_FIELDS,
      limit: String(TEMPLATE_PAGE_LIMIT),
    };
    if (after) query.after = after;

    const page = await metaGet({
      version: metaGraphApiVersion,
      path: `${wabaId}/message_templates`,
      accessToken,
      query,
    });

    const batch = Array.isArray(page?.data) ? page.data : [];
    templates.push(...batch);

    const nextCursor = page?.paging?.cursors?.after;
    if (!nextCursor || batch.length === 0) break;
    after = nextCursor;
  }

  return templates;
}

/**
 * Lista templates já criados no WABA (Meta) e faz upsert em SAAS_Templates_Meta.
 * Body: { conexaoId }
 */
export async function handleSyncTemplates(body, { metaGraphApiVersion }) {
  const conexaoId = body.conexaoId || body.conexao_id || body.idConexao;

  if (!conexaoId) throw new HttpError('Campo conexaoId obrigatorio.');

  const conexao = await fetchConexaoApiOficialById(conexaoId);
  assertConexaoApiOficial(conexao);

  const metaTemplates = await fetchAllMessageTemplates({
    wabaId: conexao.waba_id,
    accessToken: conexao.access_token,
    metaGraphApiVersion,
  });

  const now = new Date().toISOString();
  const rows = metaTemplates
    .filter((tpl) => tpl?.name)
    .map((tpl) =>
      mapMetaTemplateToRow(tpl, {
        conexaoId: Number(conexaoId) || conexaoId,
        wabaId: conexao.waba_id,
        now,
      }),
    );

  const saved = rows.length ? await upsertTemplatesMeta(rows) : [];

  return {
    ok: true,
    conexaoId: Number(conexaoId) || conexaoId,
    wabaId: conexao.waba_id,
    totalMeta: metaTemplates.length,
    totalSalvos: saved.length,
    templates: saved.map((row) => ({
      id: row.id,
      nome: row.nome,
      idioma: row.idioma,
      status: row.status,
      metaTemplateId: row.metaTemplateId,
    })),
  };
}
