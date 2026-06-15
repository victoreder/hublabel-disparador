import { config } from './config.js';
import { logger } from './logger.js';

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class MetaApiError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

export async function sendTemplateMessage({ phoneNumberId, accessToken, payload }) {
  const url = `https://graph.facebook.com/${config.metaGraphApiVersion}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await safeJson(response);

  if (!response.ok) {
    const message =
      body?.error?.message ||
      body?.error?.error_user_msg ||
      `Erro HTTP ${response.status} ao enviar mensagem na Meta`;

    throw new MetaApiError(message, {
      status: response.status,
      body,
      retryable: TRANSIENT_STATUS.has(response.status),
    });
  }

  if (body?.error) {
    throw new MetaApiError(body.error.message || 'Erro retornado pela Meta', {
      status: response.status,
      body,
      retryable: false,
    });
  }

  return { status: response.status, body };
}

export async function sendWithRetries(sendFn, { maxRetries }) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await sendFn();
    } catch (error) {
      const retryable = error instanceof MetaApiError && error.retryable;
      const isLastAttempt = attempt >= maxRetries;

      if (!retryable || isLastAttempt) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt);
      logger.warn('Retry após erro transitório na Meta', {
        attempt,
        maxRetries,
        delayMs,
        status: error.status,
        message: error.message,
      });
      await sleep(delayMs);
    }
  }
}

function getRetryDelayMs(error, attempt) {
  if (error instanceof MetaApiError && error.status === 429) {
    return Math.min(30_000, 5_000 * attempt);
  }
  return Math.min(10_000, 2_000 * 2 ** (attempt - 1));
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
