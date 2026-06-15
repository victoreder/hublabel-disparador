/**
 * Resolve Payload do detalhe usando variaveisCampos do template + dados do contato.
 */

export function parseTemplateComponentes(raw) {
  if (raw == null) return { components: [], variaveisCampos: {} };

  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { components: [], variaveisCampos: {} };
    }
  }

  if (Array.isArray(data)) {
    return { components: data, variaveisCampos: {} };
  }

  return {
    components: data.componentes || data.components || [],
    variaveisCampos: data.variaveisCampos || {},
  };
}

export function parseVariaveisCampos(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

export function extractVariableIndexes(text) {
  const matches = [...String(text ?? '').matchAll(/\{\{(\d+)\}\}/g)];
  const indexes = matches.map((m) => Number.parseInt(m[1], 10)).filter(Number.isFinite);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function normalizePayload(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function getComponentText(component) {
  if (!component) return '';
  return component.text || component.example?.body_text?.[0]?.[0] || '';
}

function buildFieldResolver({ contato, valoresPorCampo, camposPorId }) {
  return (campoId) => {
    const id = Number(campoId);
    if (!Number.isFinite(id)) return '';

    const valorSalvo = valoresPorCampo.get(id);
    if (valorSalvo != null && String(valorSalvo).trim() !== '') {
      return String(valorSalvo);
    }

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
      if (variaveis[slug] != null && String(variaveis[slug]).trim() !== '') {
        return String(variaveis[slug]);
      }
    }

    if (variaveis[nomeCampo] != null && String(variaveis[nomeCampo]).trim() !== '') {
      return String(variaveis[nomeCampo]);
    }

    return String(contato?.nome ?? '');
  };
}

function resolveMappedParams(mapping, indexes, resolveField) {
  return indexes.map((idx) => {
    const campoId = mapping?.[String(idx)] ?? mapping?.[idx];
    if (campoId == null) return '';
    return resolveField(campoId);
  });
}

function resolveButtons(variaveisCampos, components, resolveField) {
  const buttonsMapping = variaveisCampos?.buttons;
  if (!Array.isArray(buttonsMapping) || !buttonsMapping.length) return [];

  const buttonsComponent = components.find(
    (c) => String(c?.type || '').toUpperCase() === 'BUTTONS',
  );
  const templateButtons = buttonsComponent?.buttons || [];

  return buttonsMapping
    .map((item) => {
      const index = item?.index ?? item?.idx;
      const campoId = item?.fieldId ?? item?.idCampo ?? item?.campoId;
      if (index == null || campoId == null) return null;

      const templateButton = templateButtons[Number(index)];
      const buttonType = String(templateButton?.type || item?.type || '').toUpperCase();

      if (buttonType === 'URL') {
        return {
          type: 'url',
          index: Number(index),
          payload: resolveField(campoId),
        };
      }

      if (buttonType === 'QUICK_REPLY') {
        return {
          type: 'quick_reply',
          index: Number(index),
          payload: resolveField(campoId),
        };
      }

      return null;
    })
    .filter(Boolean);
}

export function resolveTemplatePayload({
  detailPayload,
  templateComponentes,
  templateVariaveisCampos,
  contato,
  valoresCampos = [],
  camposPersonalizados = [],
}) {
  const parsed = parseTemplateComponentes(templateComponentes);
  const variaveisCampos = {
    ...parseVariaveisCampos(templateVariaveisCampos),
    ...parseVariaveisCampos(parsed.variaveisCampos),
  };

  const components = parsed.components;
  const resolveField = buildFieldResolver({
    contato,
    valoresPorCampo: new Map(
      valoresCampos.map((row) => [Number(row.idCampo), row.valor]),
    ),
    camposPorId: new Map(camposPersonalizados.map((row) => [Number(row.id), row])),
  });

  const bodyComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'BODY');
  const headerComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'HEADER');

  const bodyIndexes = extractVariableIndexes(getComponentText(bodyComponent));
  const headerIndexes = extractVariableIndexes(getComponentText(headerComponent));

  const resolved = {
    body: resolveMappedParams(variaveisCampos.body, bodyIndexes, resolveField),
    buttons: resolveButtons(variaveisCampos, components, resolveField),
  };

  const headerType = String(headerComponent?.format || headerComponent?.type || '').toLowerCase();
  if (headerIndexes.length > 0 && variaveisCampos.header) {
    const headerText = resolveMappedParams(variaveisCampos.header, headerIndexes, resolveField);
    if (headerText[0]) {
      resolved.header = { type: 'text', text: headerText[0] };
    }
  } else if (['image', 'video', 'document'].includes(headerType)) {
    resolved.header = { type: headerType };
  }

  const manual = normalizePayload(detailPayload);

  return {
    body: Array.isArray(manual.body) && manual.body.length > 0 ? manual.body : resolved.body,
    header: manual.header || resolved.header,
    buttons: Array.isArray(manual.buttons) && manual.buttons.length > 0 ? manual.buttons : resolved.buttons,
  };
}
