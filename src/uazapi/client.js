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

function isClearDisconnectError(text) {
  const t = String(text || '')
    .toLowerCase()
    .trim();
  if (!t) return false;
  return (
    t.includes('instance is not connected') ||
    t.includes('instance not connected') ||
    t.includes('instance disconnected') ||
    t.includes('not connected')
  );
}

function isConnectionClosedError(text) {
  const t = String(text || '')
    .toLowerCase()
    .trim();
  return t.includes('connection closed') || t.includes('connection close');
}

/** Classifica erro UazAPI no mesmo vocabulário do disparador Evolution. */
export function classifyUazapiError(err) {
  if (!(err instanceof UazapiError)) return 'unexpected';
  const status = err.status;
  const message = extractUazapiErrorText(err).toLowerCase();

  if (status === 504) return 'timeout';
  if (status === 502) return 'offline';
  if (status === 429) return 'retryable';
  if (isConnectionClosedError(message)) return 'connectionClosed';
  if (isClearDisconnectError(message)) return 'disconnected';
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return 'apiError';
  }
  if (status === 500 || status === 503) return 'retryable';
  return 'unexpected';
}

export function isRetryableUazapiKind(kind) {
  return (
    kind === 'timeout' ||
    kind === 'offline' ||
    kind === 'connectionClosed' ||
    kind === 'retryable'
  );
}

function normalizeChatCheckResults(data, fallbackNumbers = []) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.result)
      ? data.result
      : data
        ? [data]
        : [];

  if (!list.length) {
    return fallbackNumbers.map((number) => ({ number, exists: false, jid: null }));
  }

  return list.map((item, i) => {
    const o = item && typeof item === 'object' ? item : {};
    const jid = String(o.jid || o.JID || o.wa_chatid || '');
    const exists = Boolean(
      o.exists ?? o.isInWhatsapp ?? o.isWA ?? o.onWhatsapp ?? Boolean(jid),
    );
    return {
      exists,
      jid: jid || (exists ? `${fallbackNumbers[i] || ''}@s.whatsapp.net` : null),
      number: String(o.number || o.query || o.phone || fallbackNumbers[i] || ''),
      lid: o.lid || o.jidLid || o.lidJid || null,
    };
  });
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
    const api = {
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
      /**
       * POST /chat/check — body { numbers: string[] }.
       * Compatível com ensureContactValidatedForDispatch (Evolution API shape).
       */
      async checkWhatsAppNumbers(_instanceName, numbers) {
        const cleaned = (Array.isArray(numbers) ? numbers : [numbers])
          .map((n) => String(n || '').replace(/\D/g, ''))
          .filter((n) => n.length >= 10);
        if (!cleaned.length) return [];

        const data = await request('POST', '/chat/check', {
          token,
          body: { numbers: cleaned },
        });

        return normalizeChatCheckResults(data, cleaned);
      },
      async checkNumber(phone) {
        const results = await api.checkWhatsAppNumbers(null, [phone]);
        return results[0] || { exists: false, number: String(phone || ''), jid: null };
      },
      downloadMessage(payload) {
        return request('POST', '/message/download', { token, body: payload });
      },
      getChatDetails(chatId) {
        const number = String(chatId || '').replace(/@.+$/, '').trim();
        return request('POST', '/chat/details', {
          token,
          body: { number, chatId: number },
        });
      },
      getNameAndImageURL(chatId) {
        const number = String(chatId || '').replace(/@.+$/, '').trim();
        return request('POST', '/chat/GetNameAndImageURL', {
          token,
          body: { number, preview: true, returnMoreNames: true },
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
    return api;
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
  const typeFlat = String(message?.type || '').toLowerCase();
  const mediaType = String(message?.mediaType || typeFlat || '').toLowerCase();
  const messageType = String(message?.messageType || '').toLowerCase();
  const content =
    message?.content && typeof message.content === 'object' && !Array.isArray(message.content)
      ? message.content
      : {};
  const mime = String(content.mimetype || content.mimeType || '').toLowerCase();
  const tipoHint = `${mediaType} ${typeFlat} ${messageType}`;

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

  if (
    mediaType === 'sticker' ||
    typeFlat === 'sticker' ||
    messageType.includes('sticker')
  ) {
    return 'stickerMessage';
  }
  if (
    mediaType === 'image' ||
    typeFlat === 'image' ||
    messageType.includes('image') ||
    mime.startsWith('image/')
  ) {
    return 'imageMessage';
  }
  if (
    mediaType === 'video' ||
    typeFlat === 'video' ||
    messageType.includes('video') ||
    mime.startsWith('video/')
  ) {
    return 'videoMessage';
  }
  if (
    mediaType === 'audio' ||
    mediaType === 'ptt' ||
    mediaType === 'myaudio' ||
    typeFlat === 'audio' ||
    typeFlat === 'ptt' ||
    messageType.includes('audio') ||
    mime.startsWith('audio/')
  ) {
    return 'audioMessage';
  }
  if (
    mediaType === 'document' ||
    mediaType === 'file' ||
    typeFlat === 'document' ||
    typeFlat === 'file' ||
    messageType.includes('document') ||
    mime.includes('pdf')
  ) {
    return 'documentMessage';
  }
  if (messageType.includes('reaction') || message?.reaction) return 'reactionMessage';
  return 'conversation';
}
