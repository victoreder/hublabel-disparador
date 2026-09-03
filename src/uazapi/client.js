export class UazapiError extends Error {
  constructor(status, message, body) {
    super(message || `UazAPI HTTP ${status}`);
    this.name = 'UazapiError';
    this.status = status;
    this.messageText = message || '';
    this.body = body;
  }
}

function flattenMessage(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => flattenMessage(item)).filter(Boolean).join(' ');
  }
  if (typeof value === 'object') {
    if (value.message != null) return flattenMessage(value.message);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function extractUazapiErrorText(err) {
  if (!(err instanceof UazapiError)) {
    return err instanceof Error ? err.message : String(err ?? '');
  }
  const body = err.body;
  return String(
    flattenMessage(body?.message) ||
      flattenMessage(body?.error) ||
      err.messageText ||
      err.message ||
      '',
  );
}

export function isUazapiConnected(statusPayload) {
  const status = String(
    statusPayload?.instance?.status ||
      statusPayload?.status ||
      statusPayload?.instance?.connectionStatus ||
      '',
  )
    .toLowerCase()
    .trim();
  return status === 'connected' || status === 'open';
}

/**
 * Client UazAPI (token por instância; admintoken só para create).
 * @param {{ baseUrl: string, adminToken?: string, instanceToken?: string }} config
 */
export function createUazapiClient(config) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const adminToken = config.adminToken ? String(config.adminToken).trim() : '';
  const defaultInstanceToken = config.instanceToken
    ? String(config.instanceToken).trim()
    : '';

  if (!baseUrl) {
    throw new Error('UazAPI baseUrl obrigatória');
  }

  async function request(method, path, { auth = 'instance', token, body } = {}) {
    const headers = {};
    if (auth === 'admin') {
      if (!adminToken) throw new Error('UazAPI admintoken ausente');
      headers.admintoken = adminToken;
    } else {
      const instanceToken = String(token || defaultInstanceToken || '').trim();
      if (!instanceToken) throw new Error('UazAPI token da instância ausente');
      headers.token = instanceToken;
    }

    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        flattenMessage(parsed?.message) ||
        flattenMessage(parsed?.error) ||
        (typeof parsed === 'string' ? parsed : '') ||
        res.statusText;
      throw new UazapiError(res.status, String(message), parsed);
    }

    return parsed;
  }

  function withToken(token) {
    return {
      getStatus() {
        return request('GET', '/instance/status', { token });
      },
      connect(payload = {}) {
        const body = payload.phone || payload.number
          ? { phone: String(payload.phone || payload.number) }
          : undefined;
        return request('POST', '/instance/connect', { token, body });
      },
      disconnect() {
        return request('POST', '/instance/disconnect', { token });
      },
      setWebhook(payload) {
        return request('POST', '/webhook', { token, body: payload });
      },
      sendText(number, text, options = {}) {
        return request('POST', '/send/text', {
          token,
          body: {
            number,
            text,
            ...(options.delay !== undefined ? { delay: options.delay } : {}),
            ...(options.quoted ? { quoted: options.quoted } : {}),
          },
        });
      },
      sendMedia(payload) {
        return request('POST', '/send/media', { token, body: payload });
      },
      checkNumber(phone) {
        return request('POST', '/chat/check', {
          token,
          body: { phone: String(phone) },
        });
      },
      downloadMessage(payload) {
        return request('POST', '/message/download', { token, body: payload });
      },
      getChatDetails(chatId) {
        return request('POST', '/chat/details', {
          token,
          body: { chatId: String(chatId) },
        });
      },
      listChats() {
        return request('GET', '/chat/list', { token });
      },
      listGroups() {
        return request('GET', '/group/list', { token });
      },
      getGroupInfo(groupJid) {
        return request('POST', '/group/info', {
          token,
          body: { groupjid: String(groupJid) },
        });
      },
    };
  }

  return {
    createInstance(payload) {
      return request('POST', '/instance/init', {
        auth: 'admin',
        body: payload,
      });
    },
    listInstances() {
      return request('GET', '/instance/all', { auth: 'admin' });
    },
    withToken,
    /** Atalho quando o client já nasceu com instanceToken. */
    ...withToken(defaultInstanceToken),
  };
}

export function extractUazapiMessageId(response) {
  return (
    response?.messageid ||
    response?.messageId ||
    response?.id ||
    response?.message?.messageid ||
    response?.message?.id ||
    null
  );
}

export function mapEvolutionMediaTypeToUazapi(messageType) {
  const t = String(messageType || '').toLowerCase();
  if (t.includes('audio') || t === 'ptt') return 'ptt';
  if (t.includes('image') || t === 'image') return 'image';
  if (t.includes('video') || t === 'video') return 'video';
  if (t.includes('sticker') || t === 'sticker') return 'sticker';
  return 'document';
}

export function mapUazapiMessageTypeToEvolution(message) {
  const mediaType = String(message?.mediaType || message?.type || '').toLowerCase();
  const messageType = String(message?.messageType || '').toLowerCase();
  const tipoHint = `${mediaType} ${messageType}`;

  // Clique de botão/lista — sempre texto (antes de document!)
  if (
    /button|list.?response|interactive|native.?flow|buttons_response/i.test(tipoHint) ||
    message?.vote ||
    message?.buttonOrListid ||
    message?.buttonOrListId ||
    message?.selectedButtonId ||
    message?.selectedDisplayText
  ) {
    return 'conversation';
  }

  if (mediaType === 'image' || messageType.includes('image')) return 'imageMessage';
  if (mediaType === 'video' || messageType.includes('video')) return 'videoMessage';
  if (
    mediaType === 'audio' ||
    mediaType === 'ptt' ||
    mediaType === 'myaudio' ||
    messageType.includes('audio')
  ) {
    return 'audioMessage';
  }
  if (mediaType === 'sticker' || messageType.includes('sticker')) return 'stickerMessage';
  if (
    mediaType === 'document' ||
    mediaType === 'file' ||
    messageType.includes('document')
  ) {
    return 'documentMessage';
  }
  if (messageType.includes('reaction') || message?.reaction) return 'reactionMessage';
  return 'conversation';
}
