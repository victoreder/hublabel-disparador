export class EvolutionError extends Error {
  constructor(status, message, body) {
    super(message || `Evolution HTTP ${status}`);
    this.name = 'EvolutionError';
    this.status = status;
    this.messageText = message || '';
    this.body = body;
  }
}

function flattenEvolutionMessage(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenEvolutionMessage(item))
      .filter(Boolean)
      .join(' ');
  }
  if (typeof value === 'object') {
    if (value.message != null) return flattenEvolutionMessage(value.message);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function extractEvolutionErrorText(err) {
  if (!(err instanceof EvolutionError)) {
    return err instanceof Error ? err.message : String(err ?? '');
  }

  const body = err.body;
  const fromBody =
    flattenEvolutionMessage(body?.response?.message) ||
    flattenEvolutionMessage(body?.message) ||
    flattenEvolutionMessage(body?.error) ||
    (typeof body === 'string' ? body : '');

  return String(fromBody || err.messageText || err.message || '');
}

function isPrismaOrInternalEvolutionError(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('prisma') ||
    t.includes('prismarepository') ||
    t.includes('this.cache') ||
    t.includes('invalid `this.') ||
    t.includes('invalid this.') ||
    t.includes('evolution/dist/main')
  );
}

function isConnectionClosedError(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('connection closed') || t.includes('connection is closed');
}

/** Sinais claros de sessão/instância fora — não usar para erros genéricos 500. */
function isClearDisconnectError(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (t === 'exist') return true;
  return (
    t.includes('instance is not connected') ||
    t.includes('instance not connected') ||
    t.includes('instance disconnected')
  );
}

export function isInstanceConnectionOpen(statePayload) {
  const state = String(
    statePayload?.instance?.state ||
      statePayload?.state ||
      statePayload?.instance?.connectionStatus ||
      '',
  )
    .toLowerCase()
    .trim();
  return state === 'open' || state === 'connected';
}

export function createEvolutionClient(config) {
  const baseUrl = config.evolutionBaseUrl;
  const apiKey = config.evolutionApiKey;

  async function request(method, path, instanceName, payload) {
    const url = `${baseUrl}${path}/${encodeURIComponent(instanceName)}`;
    const res = await fetch(url, {
      method,
      headers: {
        apikey: apiKey,
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });

    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const message =
        flattenEvolutionMessage(body?.response?.message) ||
        flattenEvolutionMessage(body?.message) ||
        flattenEvolutionMessage(body?.error) ||
        (typeof body === 'string' ? body : '') ||
        res.statusText;
      throw new EvolutionError(res.status, String(message), body);
    }

    return body;
  }

  function post(path, instanceName, payload) {
    return request('POST', path, instanceName, payload);
  }

  return {
    checkWhatsAppNumbers(instanceName, numbers) {
      return post('/chat/whatsappNumbers', instanceName, { numbers });
    },
    sendText(instanceName, number, text, options = {}) {
      return post('/message/sendText', instanceName, {
        number,
        text,
        ...(options.delay !== undefined ? { delay: options.delay } : {}),
        ...(options.quoted ? { quoted: options.quoted } : {}),
        ...(options.mentionsEveryOne !== undefined
          ? { mentionsEveryOne: options.mentionsEveryOne }
          : {}),
      });
    },
    sendMedia(instanceName, payload) {
      return post('/message/sendMedia', instanceName, payload);
    },
    sendWhatsAppAudio(instanceName, number, audio, options = {}) {
      return post('/message/sendWhatsAppAudio', instanceName, {
        number,
        audio,
        ...(options.mentionsEveryOne !== undefined
          ? { mentionsEveryOne: options.mentionsEveryOne }
          : {}),
      });
    },
    getConnectionState(instanceName) {
      return request('GET', '/instance/connectionState', instanceName);
    },
  };
}

/**
 * Classifica erro da Evolution para retry / falha individual / desconexão.
 * HTTP 500 genérico NÃO é desconexão — só sinais claros (ex.: connection closed
 * após esgotar retry + estado real) ou mensagens inequívocas de sessão.
 */
export function classifyEvolutionError(err) {
  if (!(err instanceof EvolutionError)) return 'unexpected';

  const status = err.status;
  const message = extractEvolutionErrorText(err).toLowerCase();

  if (status === 504) return 'timeout';
  if (status === 502) return 'offline';

  // Corpo primeiro: Prisma/cache e Connection Closed são transitórios.
  if (isPrismaOrInternalEvolutionError(message)) return 'retryable';
  if (isConnectionClosedError(message)) return 'connectionClosed';
  if (isClearDisconnectError(message)) return 'disconnected';

  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return 'apiError';
  }

  // 500/503 internos sem sinal de desconexão → retry, nunca swap.
  if (status === 500 || status === 503) return 'retryable';

  return 'unexpected';
}

export function isRetryableEvolutionKind(kind) {
  return (
    kind === 'timeout' ||
    kind === 'offline' ||
    kind === 'connectionClosed' ||
    kind === 'retryable'
  );
}

export function mapMessageType(mediaType, evolutionResponse) {
  const fromApi =
    evolutionResponse?.messageType ||
    evolutionResponse?.message?.messageType ||
    evolutionResponse?.key?.messageType;

  if (fromApi) return String(fromApi);
  if (!mediaType || mediaType === 'conversation') return 'conversation';
  return mediaType;
}
