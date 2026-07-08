export class EvolutionError extends Error {
  constructor(status, message, body) {
    super(message || `Evolution HTTP ${status}`);
    this.name = 'EvolutionError';
    this.status = status;
    this.messageText = message || '';
    this.body = body;
  }
}

export function createEvolutionClient(config) {
  const baseUrl = config.evolutionBaseUrl;
  const apiKey = config.evolutionApiKey;

  async function post(path, instanceName, payload) {
    const url = `${baseUrl}${path}/${encodeURIComponent(instanceName)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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
        body?.message ||
        body?.error ||
        (typeof body === 'string' ? body : '') ||
        res.statusText;
      throw new EvolutionError(res.status, String(message), body);
    }

    return body;
  }

  return {
    checkWhatsAppNumbers(instanceName, numbers) {
      return post('/chat/whatsappNumbers', instanceName, { numbers });
    },
    sendText(instanceName, number, text, options = {}) {
      return post('/message/sendText', instanceName, {
        number,
        text,
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
  };
}

export function classifyEvolutionError(err) {
  if (!(err instanceof EvolutionError)) return 'unexpected';

  const status = err.status;
  const message = String(err.messageText || err.message || '').toLowerCase();

  if (status === 504) return 'timeout';
  if (status === 502) return 'offline';
  if (status === 400) return 'apiError';
  if (status === 500) return 'disconnected';
  if (message.includes('connection closed')) return 'disconnected';
  if (message === 'exist') return 'disconnected';

  return 'unexpected';
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
