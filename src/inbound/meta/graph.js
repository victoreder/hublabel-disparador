import { HttpError } from './httpError.js';
import { logger } from '../../logger.js';

function graphBase(version) {
  return `https://graph.facebook.com/${version}`;
}

function metaErrorMessage(data, fallback) {
  return data?.error?.error_user_msg || data?.error?.message || fallback;
}

export async function metaGet({ version, path, accessToken, query = {}, optional = false }) {
  const params = new URLSearchParams(query);
  if (accessToken && !params.has('access_token')) {
    params.set('access_token', accessToken);
  }

  const url = `${graphBase(version)}/${path.replace(/^\//, '')}?${params.toString()}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    if (optional) return { error: data.error || { message: metaErrorMessage(data, 'Falha na Meta API.') } };
    logger.warn('[meta-graph] GET erro', {
      path,
      status: response.status,
      message: metaErrorMessage(data, 'Falha na Meta API.'),
      code: data?.error?.code ?? null,
    });
    throw new HttpError(metaErrorMessage(data, 'Falha na Meta API.'), response.status >= 400 ? response.status : 502);
  }

  return data;
}

export async function metaPost({ version, path, accessToken, body, query = {}, headers = {} }) {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  const url = `${graphBase(version)}/${path.replace(/^\//, '')}${qs ? `?${qs}` : ''}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    logger.warn('[meta-graph] POST erro', {
      path,
      status: response.status,
      message: metaErrorMessage(data, 'Falha na Meta API.'),
      code: data?.error?.code ?? null,
    });
    throw new HttpError(metaErrorMessage(data, 'Falha na Meta API.'), response.status >= 400 ? response.status : 502);
  }

  return data;
}

export async function metaDelete({ version, path, accessToken, query = {} }) {
  const params = new URLSearchParams(query);
  const url = `${graphBase(version)}/${path.replace(/^\//, '')}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new HttpError(metaErrorMessage(data, 'Falha na Meta API.'), response.status >= 400 ? response.status : 502);
  }

  return data;
}

export async function metaUploadBinary({ version, sessionId, accessToken, buffer }) {
  const url = `${graphBase(version)}/${sessionId}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
      'Content-Type': 'application/octet-stream',
    },
    body: buffer,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new HttpError(metaErrorMessage(data, 'Falha ao enviar arquivo para a Meta.'), 502);
  }

  return data;
}

export async function exchangeCodeForToken({ version, appId, appSecret, code }) {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: '',
    code,
  });

  const response = await fetch(`${graphBase(version)}/oauth/access_token?${params.toString()}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const message = metaErrorMessage(data, 'Falha ao trocar code por token curto.');
    logger.warn('[meta-graph] oauth code->token erro', {
      status: response.status,
      message,
      code: data?.error?.code ?? null,
      type: data?.error?.type ?? null,
    });
    throw new HttpError(message, 502);
  }
  if (!data.access_token) {
    throw new HttpError('Resposta da Meta sem access_token (curto).', 502);
  }

  return data;
}

export async function exchangeLongLivedToken({ version, appId, appSecret, shortLivedToken }) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });

  const response = await fetch(`${graphBase(version)}/oauth/access_token?${params.toString()}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const message = metaErrorMessage(data, 'Falha ao trocar por token longo.');
    logger.warn('[meta-graph] oauth token longo erro', {
      status: response.status,
      message,
      code: data?.error?.code ?? null,
      type: data?.error?.type ?? null,
    });
    throw new HttpError(message, 502);
  }
  if (!data.access_token) {
    throw new HttpError('Resposta da Meta sem access_token (longo).', 502);
  }

  return data;
}
