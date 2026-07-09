import {
  deleteTemplateMetaRow,
  fetchConexaoApiOficialById,
  fetchTemplateMeta,
  insertTemplateMeta,
} from '../../supabase.js';
import { metaDelete, metaPost } from './graph.js';
import { HttpError } from './httpError.js';
import { prepareTemplateComponentsForMeta } from './templateMedia.js';

const VALID_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

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
