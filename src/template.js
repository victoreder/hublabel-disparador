/**
 * Converte Payload do detalhe + KeyRedis em components da Meta.
 *
 * Payload esperado:
 * {
 *   "body": ["João", "R$ 99,90"],
 *   "header": { "type": "image", "link": "https://..." },
 *   "buttons": [{ "type": "url", "index": 0, "payload": "https://..." }]
 * }
 */
export function buildTemplateComponents(payload, mediaUrl) {
  const components = [];
  const data = payload && typeof payload === 'object' ? payload : {};

  const headerLink = mediaUrl || data.header?.link;
  const headerType = (data.header?.type || 'image').toLowerCase();

  if (headerLink) {
    const parameter = buildHeaderParameter(headerType, headerLink);
    if (parameter) {
      components.push({
        type: 'header',
        parameters: [parameter],
      });
    }
  } else if (data.header?.type === 'text' && data.header?.text != null) {
    components.push({
      type: 'header',
      parameters: [{ type: 'text', text: String(data.header.text) }],
    });
  }

  if (Array.isArray(data.body) && data.body.length > 0) {
    components.push({
      type: 'body',
      parameters: data.body.map((text) => ({
        type: 'text',
        text: String(text ?? ''),
      })),
    });
  }

  if (Array.isArray(data.buttons)) {
    for (const button of data.buttons) {
      const component = buildButtonComponent(button);
      if (component) components.push(component);
    }
  }

  return components;
}

function buildHeaderParameter(type, link) {
  switch (type) {
    case 'video':
      return { type: 'video', video: { link } };
    case 'document':
      return { type: 'document', document: { link } };
    case 'image':
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

export function buildMetaTemplateMessage({ phone, templateName, language, components }) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'pt_BR' },
      ...(components.length > 0 ? { components } : {}),
    },
  };
}
