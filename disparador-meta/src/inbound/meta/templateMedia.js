import { fetchConfigApiOficial } from '../../supabase.js';
import { metaPost, metaUploadBinary } from './graph.js';
import { HttpError } from './httpError.js';

const MEDIA_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
};

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

function normalizeFormat(value) {
  return String(value || 'IMAGE').toUpperCase();
}

function extensionFromUrl(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const match = clean.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function mimeFromMedia({ link, format, mimeType, mimetype }) {
  const explicit = String(mimeType || mimetype || '').split(';')[0].trim().toLowerCase();
  if (explicit) return explicit;

  const fromExt = MIME_BY_EXT[extensionFromUrl(link)];
  if (fromExt) return fromExt;

  const fmt = normalizeFormat(format);
  if (fmt === 'IMAGE') return 'image/jpeg';
  if (fmt === 'VIDEO') return 'video/mp4';
  if (fmt === 'DOCUMENT') return 'application/pdf';
  return 'application/octet-stream';
}

function fileNameFromMedia({ fileName, filename, link, mimeType }) {
  const explicit = String(fileName || filename || '').trim();
  if (explicit) return explicit;

  const ext = EXT_BY_MIME[mimeType] || extensionFromUrl(link) || 'bin';
  return `template.${ext}`;
}

async function fetchMediaBuffer(link) {
  const response = await fetch(link);
  if (!response.ok) {
    throw new HttpError(`Falha ao baixar midia do template: HTTP ${response.status}`, 400);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new HttpError('Arquivo de midia vazio.', 400);
  return buffer;
}

function bufferFromBase64(raw) {
  const normalized = String(raw).trim().replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length) throw new HttpError('base64 de midia invalido.', 400);
  return buffer;
}

export async function uploadResumableMedia({
  version,
  appId,
  accessToken,
  buffer,
  fileName,
  mimeType,
}) {
  const session = await metaPost({
    version,
    path: `${appId}/uploads`,
    accessToken,
    query: {
      file_name: fileName,
      file_length: String(buffer.length),
      file_type: mimeType,
    },
    body: {},
  });

  if (!session?.id) throw new HttpError('Falha ao criar sessao de upload na Meta.');

  const uploadRes = await metaUploadBinary({
    version,
    sessionId: session.id,
    accessToken,
    buffer,
  });

  if (!uploadRes?.h) throw new HttpError('Meta nao retornou handle da midia.');
  return uploadRes.h;
}

function findMediaHeaderIndex(components) {
  return components.findIndex((component) => {
    const type = String(component?.type || '').toUpperCase();
    const format = normalizeFormat(component?.format);
    return type === 'HEADER' && MEDIA_FORMATS.has(format);
  });
}

function resolveMediaSource(body, components) {
  if (body?.headerMidia && typeof body.headerMidia === 'object') {
    return body.headerMidia;
  }

  const headerIndex = findMediaHeaderIndex(components);
  if (headerIndex < 0) return null;

  const header = components[headerIndex];
  if (header.example?.header_handle?.length) return null;

  if (header.link || header.url || header.base64) {
    return {
      format: header.format,
      link: header.link || header.url,
      base64: header.base64,
      mimeType: header.mimeType || header.mimetype,
      fileName: header.fileName || header.filename,
    };
  }

  return null;
}

function buildHeaderComponent(format, handle) {
  return {
    type: 'HEADER',
    format: normalizeFormat(format),
    example: {
      header_handle: [handle],
    },
  };
}

export async function prepareTemplateComponentsForMeta({
  body,
  components,
  accessToken,
  metaGraphApiVersion,
}) {
  const next = components.map((component) => ({ ...component }));
  const mediaSource = resolveMediaSource(body, next);
  if (!mediaSource) return next;

  const link = mediaSource.link || mediaSource.url;
  const format = normalizeFormat(mediaSource.format);
  const mimeType = mimeFromMedia({ ...mediaSource, link, format });
  const buffer = mediaSource.base64
    ? bufferFromBase64(mediaSource.base64)
    : await fetchMediaBuffer(link);
  const fileName = fileNameFromMedia({ ...mediaSource, link, mimeType });

  const config = await fetchConfigApiOficial('app_id');
  if (!config?.app_id) throw new HttpError('Config API Oficial incompleta em SAAS_Config_ApiOficial.');

  const handle = await uploadResumableMedia({
    version: metaGraphApiVersion,
    appId: config.app_id,
    accessToken,
    buffer,
    fileName,
    mimeType,
  });

  const headerIndex = findMediaHeaderIndex(next);
  const headerComponent = buildHeaderComponent(
    headerIndex >= 0 ? next[headerIndex].format : format,
    handle,
  );

  if (headerIndex < 0) {
    next.unshift(headerComponent);
    return next;
  }

  next[headerIndex] = headerComponent;
  return next;
}
