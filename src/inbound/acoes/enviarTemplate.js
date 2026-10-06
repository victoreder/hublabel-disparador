import { supabase } from '../../supabase.js';
import { HttpError } from '../meta/httpError.js';

/**
 * POST /enviar-template — envia um template da API Oficial a partir do chat/CRM.
 * Port do fluxo n8n: f_meta_preparar_envio_template → monta componentes →
 * Graph API → marca a mensagem como enviada em SAAS_Mensagens.
 */

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  return raw;
}

function parseTemplateComponentes(raw) {
  const data = parseJson(raw, null);
  if (data == null) return { components: [], variaveisCampos: {} };
  if (Array.isArray(data)) return { components: data, variaveisCampos: {} };
  return {
    components: data.componentes || data.components || [],
    variaveisCampos: data.variaveisCampos || {},
  };
}

function parseVariaveisCampos(raw) {
  const data = parseJson(raw, {});
  return typeof data === 'object' && data ? data : {};
}

function extractVariableIndexes(text) {
  const matches = [...String(text ?? '').matchAll(/\{\{(\d+)\}\}/g)];
  return [...new Set(matches.map((m) => Number.parseInt(m[1], 10)).filter(Number.isFinite))].sort(
    (a, b) => a - b,
  );
}

function getComponentText(component) {
  if (!component) return '';
  return component.text || component.example?.body_text?.[0]?.[0] || '';
}

function buildHeaderParameter(type, link) {
  switch (String(type || 'image').toLowerCase()) {
    case 'video':
      return { type: 'video', video: { link } };
    case 'document':
      return { type: 'document', document: { link } };
    default:
      return { type: 'image', image: { link } };
  }
}

function buildButtonComponent(button) {
  if (!button || button.index == null) return null;
  const index = String(button.index);
  const type = String(button.type || '').toLowerCase();
  if (type === 'url') {
    return {
      type: 'button',
      sub_type: 'url',
      index,
      parameters: [{ type: 'text', text: String(button.payload ?? '') }],
    };
  }
  if (type === 'quick_reply') {
    return {
      type: 'button',
      sub_type: 'quick_reply',
      index,
      parameters: [{ type: 'payload', payload: String(button.payload ?? '') }],
    };
  }
  return null;
}

/** Monta o payload da Graph API a partir do retorno de f_meta_preparar_envio_template. */
export function buildTemplatePayload(prep) {
  const { template, contato } = prep;
  const valoresCampos = Array.isArray(prep.valoresCampos) ? prep.valoresCampos : [];
  const camposPersonalizados = Array.isArray(prep.camposPersonalizados) ? prep.camposPersonalizados : [];

  const telefone = String(contato?.telefone || '').replace(/\D/g, '');
  if (!telefone) throw new HttpError('Contato sem telefone valido.', 400);

  const valoresPorCampo = new Map(valoresCampos.map((row) => [Number(row.idCampo), row.valor]));
  const camposPorId = new Map(camposPersonalizados.map((row) => [Number(row.id), row]));

  function resolveField(campoId) {
    const id = Number(campoId);
    if (!Number.isFinite(id)) return '';

    const valorSalvo = valoresPorCampo.get(id);
    if (valorSalvo != null && String(valorSalvo).trim() !== '') return String(valorSalvo);

    const campo = camposPorId.get(id);
    const nomeCampo = String(campo?.nome || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '');

    if (nomeCampo === 'nome') return String(contato?.nome ?? '');
    if (nomeCampo === 'telefone') return String(contato?.telefone ?? '');

    const variaveis = contato?.variaveis && typeof contato.variaveis === 'object' ? contato.variaveis : {};
    if (campo?.nome) {
      const slug = String(campo.nome).toLowerCase().replace(/\s+/g, '_');
      if (variaveis[slug] != null && String(variaveis[slug]).trim() !== '') return String(variaveis[slug]);
    }
    if (variaveis[nomeCampo] != null && String(variaveis[nomeCampo]).trim() !== '') {
      return String(variaveis[nomeCampo]);
    }
    return String(contato?.nome ?? '');
  }

  function resolveMappedParams(mapping, indexes) {
    return indexes.map((idx) => {
      const campoId = mapping?.[String(idx)] ?? mapping?.[idx];
      if (campoId == null) return '';
      return resolveField(campoId);
    });
  }

  const parsed = parseTemplateComponentes(template.componentes);
  const variaveisCampos = {
    ...parseVariaveisCampos(template.variaveisCampos),
    ...parseVariaveisCampos(parsed.variaveisCampos),
  };
  const templateParts = parsed.components;
  const byType = (type) => templateParts.find((c) => String(c?.type || '').toUpperCase() === type);

  const bodyComponent = byType('BODY');
  const headerComponent = byType('HEADER');
  const buttonsComponent = byType('BUTTONS');

  const bodyIndexes = extractVariableIndexes(getComponentText(bodyComponent));
  const headerIndexes = extractVariableIndexes(getComponentText(headerComponent));

  const resolved = { body: resolveMappedParams(variaveisCampos.body, bodyIndexes), buttons: [] };

  const headerFormat = String(headerComponent?.format || '').toLowerCase();
  if (headerIndexes.length > 0 && variaveisCampos.header) {
    const headerText = resolveMappedParams(variaveisCampos.header, headerIndexes);
    if (headerText[0]) resolved.header = { type: 'text', text: headerText[0] };
  } else if (['image', 'video', 'document'].includes(headerFormat)) {
    const headerMap = variaveisCampos.header;
    let mediaUrl = null;
    if (headerMap && typeof headerMap === 'object') {
      const keys = Object.keys(headerMap).sort((a, b) => Number(a) - Number(b));
      if (keys.length) mediaUrl = resolveField(headerMap[keys[0]]);
    }
    resolved.header = mediaUrl ? { type: headerFormat, link: mediaUrl } : { type: headerFormat };
  }

  const buttonsMapping = variaveisCampos.buttons;
  if (Array.isArray(buttonsMapping) && buttonsMapping.length) {
    const templateButtons = buttonsComponent?.buttons || [];
    resolved.buttons = buttonsMapping
      .map((item) => {
        const index = item?.index ?? item?.idx;
        const campoId = item?.fieldId ?? item?.idCampo ?? item?.campoId;
        if (index == null || campoId == null) return null;
        const templateButton = templateButtons[Number(index)];
        const buttonType = String(templateButton?.type || item?.type || '').toUpperCase();
        if (buttonType === 'URL') return { type: 'url', index: Number(index), payload: resolveField(campoId) };
        if (buttonType === 'QUICK_REPLY') {
          return { type: 'quick_reply', index: Number(index), payload: resolveField(campoId) };
        }
        return null;
      })
      .filter(Boolean);
  }

  if (bodyIndexes.length > 0 && resolved.body.length < bodyIndexes.length) {
    throw new HttpError(
      `Template exige ${bodyIndexes.length} variavel(is) no body; variaveisCampos resolveu ${resolved.body.length}`,
      400,
    );
  }

  const metaComponents = [];
  const headerLink = resolved.header?.link;
  const headerType = (resolved.header?.type || 'image').toLowerCase();

  if (headerLink) {
    metaComponents.push({ type: 'header', parameters: [buildHeaderParameter(headerType, headerLink)] });
  } else if (resolved.header?.type === 'text' && resolved.header?.text != null) {
    metaComponents.push({
      type: 'header',
      parameters: [{ type: 'text', text: String(resolved.header.text) }],
    });
  }

  if (resolved.body.length > 0) {
    metaComponents.push({
      type: 'body',
      parameters: resolved.body.map((text) => ({ type: 'text', text: String(text ?? '') })),
    });
  }

  for (const button of resolved.buttons) {
    const component = buildButtonComponent(button);
    if (component) metaComponents.push(component);
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefone,
    type: 'template',
    template: {
      name: template.nome,
      language: { code: template.idioma || 'pt_BR' },
      ...(metaComponents.length > 0 ? { components: metaComponents } : {}),
    },
  };
}

export async function enviarTemplate(body, { graphVersion }) {
  const { data: prep, error } = await supabase.rpc('f_hub_meta_preparar_envio_template', {
    p_body: body ?? {},
  });
  if (error) throw new HttpError(`Erro ao preparar template: ${error.message}`, 500);
  if (!prep?.ok) throw new HttpError(prep?.error || 'Falha ao preparar dados do template.', 400);

  const payload = buildTemplatePayload(prep);
  const res = await fetch(
    `https://graph.facebook.com/${graphVersion}/${prep.conexao.phone_number_id}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${prep.conexao.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const metaRes = await res.json().catch(() => ({}));
  if (!res.ok || metaRes.error) {
    const message =
      metaRes.error?.error_user_msg || metaRes.error?.message || `Meta respondeu ${res.status}`;
    throw new HttpError(message, 502);
  }

  const metaMessageId = metaRes.messages?.[0]?.id || null;
  if (!metaMessageId) throw new HttpError('Meta nao retornou message id.', 502);

  const { error: updError } = await supabase
    .from('SAAS_Mensagens')
    .update({
      enviada: true,
      tipoMensagem: 'conversation',
      metaMessageId,
      metaStatus: 'sent',
    })
    .eq('id', prep.idMensagem);
  if (updError) throw new HttpError(`Template enviado, mas falhou ao salvar: ${updError.message}`, 500);

  return { ok: true, idMensagem: prep.idMensagem, metaMessageId, metaStatus: 'sent' };
}
