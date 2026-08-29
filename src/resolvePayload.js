import { normalizePhone } from './phone.js';

/**
 * Resolve variáveis do template a partir de variaveisCampos + dados do contato.
 * Fonte: SAAS_Templates_Meta.componentes.variaveisCampos ou coluna variaveisCampos.
 */

function parseJsonDeep(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return parseJsonDeep(JSON.parse(raw), fallback);
  } catch {
    return fallback;
  }
}

function extractComponentsList(data, depth = 0) {
  if (depth > 6 || data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') return extractComponentsList(parseJsonDeep(data, null), depth + 1);
  if (typeof data !== 'object') return [];

  if (Array.isArray(data.componentes)) return data.componentes;
  if (Array.isArray(data.components)) return data.components;

  // Nested blob: { componentes: { componentes: [...] } } or stringified inner list
  if (data.componentes != null) {
    const nested = extractComponentsList(data.componentes, depth + 1);
    if (nested.length) return nested;
  }
  if (data.components != null) {
    const nested = extractComponentsList(data.components, depth + 1);
    if (nested.length) return nested;
  }

  return [];
}

export function parseTemplateComponentes(raw) {
  if (raw == null) return { components: [], variaveisCampos: {} };

  const data = parseJsonDeep(raw, null);
  if (data == null) return { components: [], variaveisCampos: {} };

  if (Array.isArray(data)) {
    return { components: data, variaveisCampos: {} };
  }

  if (typeof data !== 'object') {
    return { components: [], variaveisCampos: {} };
  }

  const nestedVc =
    data.variaveisCampos && typeof data.variaveisCampos === 'object' ? data.variaveisCampos : {};

  return {
    components: extractComponentsList(data),
    variaveisCampos: nestedVc,
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

export function getComponentText(component) {
  if (!component) return '';
  return component.text || component.example?.body_text?.[0]?.[0] || '';
}

const CAMPOS_PADRAO = new Set(['nome', 'email', 'telefone']);

const DEFAULT_BODY_CAMPO_POR_INDICE = {
  1: 'nome',
  2: 'email',
};

const DEFAULT_HEADER_CAMPO_POR_INDICE = {
  1: 'nome',
};

function resolveNomeContato(contato) {
  const nome = String(contato?.nome ?? '').trim();
  if (nome) return nome;

  const telefone = normalizePhone(contato?.telefone);
  if (telefone) return telefone;

  return 'Cliente';
}

function resolveCampoPadrao(padrao, contato) {
  if (padrao === 'nome') return resolveNomeContato(contato);
  if (padrao === 'email') return String(contato?.email ?? '').trim();
  if (padrao === 'telefone') return normalizePhone(contato?.telefone) || '';
  return '';
}

function normalizeCampoRef(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

function buildFieldResolver({ contato, valoresPorCampo, camposPorId }) {
  return (campoRef) => {
    const ref = normalizeCampoRef(campoRef);
    if (!ref) return '';

    const padrao = ref.toLowerCase();
    if (CAMPOS_PADRAO.has(padrao)) {
      return resolveCampoPadrao(padrao, contato);
    }

    const id = Number(ref);
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

    if (nomeCampo === 'nome') return resolveNomeContato(contato);
    if (nomeCampo === 'email') return String(contato?.email ?? '').trim();
    if (nomeCampo === 'telefone') return normalizePhone(contato?.telefone) || '';

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

    return resolveNomeContato(contato);
  };
}

function resolveCampoRef(mapping, idx, defaults) {
  const mapped = mapping?.[String(idx)] ?? mapping?.[idx];
  if (mapped != null && String(mapped).trim() !== '') return mapped;
  return defaults?.[idx] ?? defaults?.[String(idx)] ?? 'nome';
}

function resolveMappedParams(mapping, indexes, resolveField, defaults) {
  return indexes.map((idx) => {
    const campoRef = resolveCampoRef(mapping, idx, defaults);
    return resolveField(campoRef);
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
      const campoRef = item?.campoPadrao ?? item?.fieldId ?? item?.idCampo ?? item?.campoId;
      if (index == null || campoRef == null) return null;

      const templateButton = templateButtons[Number(index)];
      const buttonType = String(templateButton?.type || item?.type || '').toUpperCase();

      if (buttonType === 'URL') {
        return {
          type: 'url',
          index: Number(index),
          payload: resolveField(campoRef),
        };
      }

      if (buttonType === 'QUICK_REPLY') {
        return {
          type: 'quick_reply',
          index: Number(index),
          payload: resolveField(campoRef),
        };
      }

      return null;
    })
    .filter(Boolean);
}

export function getTemplateVariaveisCampos(templateComponentes, templateVariaveisCampos) {
  const parsed = parseTemplateComponentes(templateComponentes);
  return {
    ...parseVariaveisCampos(templateVariaveisCampos),
    ...parseVariaveisCampos(parsed.variaveisCampos),
  };
}

export function resolveTemplatePayload({
  templateComponentes,
  templateVariaveisCampos,
  contato,
  valoresCampos = [],
  camposPersonalizados = [],
}) {
  const parsed = parseTemplateComponentes(templateComponentes);
  const variaveisCampos = getTemplateVariaveisCampos(templateComponentes, templateVariaveisCampos);
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
    body: resolveMappedParams(variaveisCampos.body, bodyIndexes, resolveField, DEFAULT_BODY_CAMPO_POR_INDICE),
    buttons: resolveButtons(variaveisCampos, components, resolveField),
  };

  const headerFormat = String(headerComponent?.format || '').toLowerCase();
  if (headerIndexes.length > 0) {
    const headerText = resolveMappedParams(
      variaveisCampos.header,
      headerIndexes,
      resolveField,
      DEFAULT_HEADER_CAMPO_POR_INDICE,
    );
    const text = String(headerText[0] ?? '').trim();
    if (text) {
      resolved.header = { type: 'text', text };
    }
  } else if (['image', 'video', 'document'].includes(headerFormat)) {
    resolved.header = { type: headerFormat };
  }

  return resolved;
}

export function findEmptyTemplateTextParameters({ payload, templateComponentes }) {
  const issues = [];
  const { components } = parseTemplateComponentes(templateComponentes);

  const bodyComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'BODY');
  const headerComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'HEADER');
  const buttonsComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'BUTTONS');

  const bodyIndexes = extractVariableIndexes(getComponentText(bodyComponent));
  bodyIndexes.forEach((idx, position) => {
    const value = payload?.body?.[position];
    if (!String(value ?? '').trim()) {
      issues.push({ component: 'body', variable: idx, position: position + 1 });
    }
  });

  const headerFormat = String(headerComponent?.format || '').toLowerCase();
  if (headerFormat === 'text') {
    const headerIndexes = extractVariableIndexes(getComponentText(headerComponent));
    if (headerIndexes.length > 0 && !String(payload?.header?.text ?? '').trim()) {
      issues.push({ component: 'header', variable: headerIndexes[0], position: 1 });
    }
  }

  const templateButtons = buttonsComponent?.buttons || [];
  for (const button of payload?.buttons || []) {
    const templateButton = templateButtons[Number(button.index)];
    const buttonType = String(templateButton?.type || button.type || '').toUpperCase();
    if (buttonType === 'URL' && !String(button.payload ?? '').trim()) {
      issues.push({ component: 'button', variable: `url:${button.index}`, position: Number(button.index) + 1 });
    }
  }

  return issues;
}

export function assertTemplateTextParameters(payload, templateComponentes) {
  const issues = findEmptyTemplateTextParameters({ payload, templateComponentes });
  if (!issues.length) return;

  const resumo = issues
    .map((issue) => {
      if (issue.component === 'body') return `body {{${issue.variable}}}`;
      if (issue.component === 'header') return `header {{${issue.variable}}}`;
      return `botão URL (índice ${issue.position})`;
    })
    .join(', ');

  throw new Error(`Variável do template sem valor: ${resumo}`);
}
