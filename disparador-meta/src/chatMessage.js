import {
  extractVariableIndexes,
  getComponentText,
  parseTemplateComponentes,
} from './resolvePayload.js';

const MEDIA_TIPO = {
  image: 'imageMessage',
  video: 'videoMessage',
  audio: 'audioMessage',
  document: 'documentMessage',
};

function applyVariables(text, values, indexes) {
  let result = String(text ?? '');
  for (let i = 0; i < indexes.length; i += 1) {
    const idx = indexes[i];
    const val = values[i] ?? '';
    result = result.replace(new RegExp(`\\{\\{${idx}\\}\\}`, 'g'), String(val));
  }
  return result;
}

/**
 * Monta texto, tipo e URL de mídia do template para exibir no chat (SAAS_Mensagens).
 */
export function buildTemplateChatPreview(templateComponentes, resolvedPayload, mediaUrl) {
  const { components } = parseTemplateComponentes(templateComponentes);
  const parts = [];

  const headerComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'HEADER');
  const bodyComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'BODY');
  const footerComponent = components.find((c) => String(c?.type || '').toUpperCase() === 'FOOTER');

  const headerFormat = String(headerComponent?.format || '').toLowerCase();
  let tipoMensagem = 'conversation';
  let arquivoUrl = null;

  if (MEDIA_TIPO[headerFormat]) {
    tipoMensagem = MEDIA_TIPO[headerFormat];
    arquivoUrl = mediaUrl || resolvedPayload?.header?.link || null;
  }

  if (headerFormat === 'text') {
    const headerTextRaw = getComponentText(headerComponent);
    const headerIndexes = extractVariableIndexes(headerTextRaw);
    const headerValues =
      resolvedPayload?.header?.text != null
        ? [String(resolvedPayload.header.text)]
        : headerIndexes.map(() => '');
    const headerText = applyVariables(headerTextRaw, headerValues, headerIndexes).trim();
    if (headerText) parts.push(headerText);
  }

  const bodyTextRaw = getComponentText(bodyComponent);
  const bodyIndexes = extractVariableIndexes(bodyTextRaw);
  const bodyValues = Array.isArray(resolvedPayload?.body) ? resolvedPayload.body : [];
  const bodyText = applyVariables(bodyTextRaw, bodyValues, bodyIndexes).trim();
  if (bodyText) parts.push(bodyText);

  const footerText = String(footerComponent?.text ?? '').trim();
  if (footerText) parts.push(footerText);

  let mensagem = parts.join('\n\n').trim();

  if (!mensagem && arquivoUrl) {
    const fallbacks = {
      imageMessage: '[imagem]',
      videoMessage: '[video]',
      audioMessage: '[audio]',
      documentMessage: '[documento]',
    };
    mensagem = fallbacks[tipoMensagem] || '[template]';
  }

  return {
    mensagem: mensagem || null,
    tipoMensagem,
    arquivoUrl: arquivoUrl || null,
  };
}
