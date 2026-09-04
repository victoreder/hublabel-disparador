import { logger } from '../../logger.js';
import { fetchConexaoById, ingestaoMensagem } from '../../supabase.js';
import {
  createUazapiClient,
  mapUazapiMessageTypeToEvolution,
} from '../../uazapi/client.js';
import { aposInboundCliente } from '../agent/followup/index.js';
import { buildAgentJobFromIngestao } from '../agent/job.js';
import { enqueueAgentJob } from '../agent/queue.js';
import { scheduleContatoFotoPerfilSync } from '../contato/fotoPerfil.js';
import {
  buildPublicS3Url,
  createS3Client,
  sanitizeS3FileName,
  uploadBuffer,
  withFileExtension,
} from '../storage/s3.js';
import { isMediaMessageType } from '../evolution/organize.js';
import {
  buildIngestaoPayloadUazapi,
  isAllowedUazapiChat,
  isPublicMediaUrl,
  organizeUazapiWebhook,
} from './organize.js';

export async function handleUazapiWebhook(req, inboundConfig, conexaoPreloaded) {
  const body = req.body ?? {};
  const idConexao = Number.parseInt(
    String(req.query?.idConexao ?? body?.idConexao ?? ''),
    10,
  );

  if (!Number.isFinite(idConexao)) {
    return { status: 400, body: { ok: false, error: 'idConexao obrigatorio na query' } };
  }

  const eventType = String(body.EventType || body.event || '').toLowerCase();
  if (eventType && eventType !== 'messages' && eventType !== 'messages_update') {
    return { status: 200, body: { ok: true, ignored: `event:${eventType || 'unknown'}` } };
  }

  const conexao = conexaoPreloaded || (await fetchConexaoById(idConexao));
  if (!conexao) {
    return { status: 404, body: { ok: false, error: 'conexao nao encontrada' } };
  }

  const organized = organizeUazapiWebhook(body, conexao);
  if (
    organized.messageType === 'reactionMessage' ||
    body?.message?.reaction ||
    body?.message?.type === 'reaction'
  ) {
    return { status: 200, body: { ok: true, ignored: 'reaction' } };
  }

  if (!isAllowedUazapiChat(organized)) {
    return { status: 200, body: { ok: true, ignored: 'group_or_invalid_jid' } };
  }

  if (isMediaMessageType(organized.messageType) && !organized.isButtonReply) {
    organized.arquivoUrl = await processUazapiMedia(organized, inboundConfig).catch(
      (error) => {
        logger.warn('Falha ao processar midia UazAPI', { message: error.message });
        return isPublicMediaUrl(organized.arquivoUrl) ? organized.arquivoUrl : null;
      },
    );
  }

  const payload = buildIngestaoPayloadUazapi({ conexao, organized });
  const resultado = await ingestaoMensagem(payload);

  if (resultado?.ok === false) {
    logger.warn('f_ingestao_mensagem retornou erro', {
      error: resultado.error,
      conexaoId: idConexao,
      provedor: 'uazapi',
    });
    return { status: 200, body: resultado };
  }

  if (resultado?.contatoId && !organized.fromMe) {
    scheduleContatoFotoPerfilSync({
      contatoId: resultado.contatoId,
      contatoCriado: Boolean(resultado.contatoCriado),
      telefone: organized.remoteJid,
      fromMe: organized.fromMe,
      canal: 'uazapi',
      conexaoId: idConexao,
      contaId: conexao.contaId,
      conexao,
      evolution: payload.evolu,
      s3Config: inboundConfig.s3,
      sourceUrl: organized.fotoUrl || null,
      nomeContato: organized.pushName || null,
      conversaId: resultado.conversaId || null,
    });
  }

  if (resultado?.segueFluxoIA) {
    if (!organized.fromMe) {
      await aposInboundCliente({
        resultado,
        fromMe: false,
        organized,
        conexao,
        canal: 'uazapi',
      });
    }
    const job = buildAgentJobFromIngestao({
      canal: 'uazapi',
      resultado,
      organized,
      conexao,
    });
    job.envio = {
      ...job.envio,
      provedorApi: 'uazapi',
      serverUrl: organized.serverUrl || conexao.urlApi,
      instance: organized.instance || conexao.instanceName,
      apikey: organized.apikey || conexao.Apikey,
    };
    enqueueAgentJob(job);
  } else if (!organized.fromMe) {
    const jobFollowup = await aposInboundCliente({
      resultado,
      fromMe: false,
      organized,
      conexao,
      canal: 'uazapi',
    });
    if (jobFollowup) {
      jobFollowup.envio = {
        ...jobFollowup.envio,
        provedorApi: 'uazapi',
        serverUrl: organized.serverUrl || conexao.urlApi,
        instance: organized.instance || conexao.instanceName,
        apikey: organized.apikey || conexao.Apikey,
      };
      enqueueAgentJob(jobFollowup);
    } else {
      logger.info('Agente não enfileirado', {
        conexaoId: idConexao,
        provedor: 'uazapi',
        conversaId: resultado?.conversaId ?? null,
        segueFluxoIA: Boolean(resultado?.segueFluxoIA),
      });
    }
  }

  return { status: 200, body: { ok: true, segueFluxoIA: Boolean(resultado?.segueFluxoIA) } };
}

function pickMediaString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function unwrapDownloadPayload(json) {
  if (!json || typeof json !== 'object') return json;
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data) && !json.base64 && !json.fileURL && !json.url) {
    return json.data;
  }
  return json;
}

function extractDownloadedMedia(json, fallbackMime) {
  const root = unwrapDownloadPayload(json) || {};
  const nested =
    (root.file && typeof root.file === 'object' && root.file) ||
    (root.media && typeof root.media === 'object' && root.media) ||
    root;
  const base64 = pickMediaString(
    nested.base64,
    nested.fileBase64,
    nested.file_base64,
    typeof json?.data === 'string' ? json.data : null,
  );
  const url = pickMediaString(
    nested.fileURL,
    nested.fileUrl,
    nested.url,
    nested.link,
    nested.mediaUrl,
  );
  const mime = pickMediaString(nested.mimetype, nested.mimeType, nested.mime, fallbackMime);
  return { base64, url, mime, raw: root };
}

function bufferFromBase64(value) {
  if (!value) return null;
  const raw = String(value).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (raw.length < 32) return null;
  const buffer = Buffer.from(raw, 'base64');
  return buffer.length > 16 ? buffer : null;
}

async function downloadUazapiMediaJson(client, organized) {
  const ids = [...new Set([organized.downloadId, organized.messageId].filter(Boolean))];
  let lastError = null;
  for (const id of ids) {
    try {
      return await client.downloadMessage({
        id,
        messageid: organized.messageId || id,
        return_base64: true,
        return_link: true,
      });
    } catch (error) {
      lastError = error;
      logger.warn('UazAPI download falhou', { id, message: error.message });
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function processUazapiMedia(organized, inboundConfig) {
  const downloadId = organized.downloadId || organized.messageId;
  if (!organized.serverUrl || !organized.apikey || !downloadId) {
    return uploadThumbnailFallback(organized, inboundConfig);
  }

  const client = createUazapiClient({
    baseUrl: organized.serverUrl,
    instanceToken: organized.apikey,
  });

  let json = null;
  try {
    json = await downloadUazapiMediaJson(client, organized);
  } catch (error) {
    const thumbUrl = await uploadThumbnailFallback(organized, inboundConfig);
    if (thumbUrl) return thumbUrl;
    throw error;
  }

  const extracted = extractDownloadedMedia(json, organized.arquivoMime);
  const mime = extracted.mime || organized.arquivoMime || null;

  const fromBase64 = bufferFromBase64(extracted.base64);
  if (fromBase64) {
    return uploadUazapiMedia({ organized, inboundConfig, buffer: fromBase64, mime, json: extracted.raw });
  }

  const publicUrl = [extracted.url, organized.arquivoUrl].find((url) => isPublicMediaUrl(url));
  if (publicUrl) {
    const buffer = await fetchPublicBuffer(publicUrl);
    if (buffer) {
      return uploadUazapiMedia({ organized, inboundConfig, buffer, mime, json: extracted.raw });
    }
    return publicUrl;
  }

  const thumbUrl = await uploadThumbnailFallback(organized, inboundConfig);
  if (thumbUrl) return thumbUrl;

  logger.warn('UazAPI download sem midia utilizavel', {
    keys: json && typeof json === 'object' ? Object.keys(json) : [],
    messageType: organized.messageType,
  });
  throw new Error('UazAPI nao retornou midia');
}

async function uploadThumbnailFallback(organized, inboundConfig) {
  if (!['imageMessage', 'stickerMessage', 'documentMessage'].includes(organized.messageType)) {
    return isPublicMediaUrl(organized.arquivoUrl) ? organized.arquivoUrl : null;
  }
  const buffer = bufferFromBase64(organized.jpegThumbnail);
  if (!buffer) return isPublicMediaUrl(organized.arquivoUrl) ? organized.arquivoUrl : null;
  return uploadUazapiMedia({
    organized,
    inboundConfig,
    buffer,
    mime: 'image/jpeg',
    json: { mimetype: 'image/jpeg' },
  });
}

async function fetchPublicBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

async function uploadUazapiMedia({ organized, inboundConfig, buffer, mime, json }) {
  const ext = guessExtension(organized.messageType, { ...json, mimetype: mime });
  const safeMessageId = String(organized.messageId || organized.downloadId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const originalName = withFileExtension(
    sanitizeS3FileName(organized.arquivoNomeOriginal, `${safeMessageId}.${ext}`),
    ext,
  );
  const s3Key = `uazapi/${organized.instance || 'inst'}/${safeMessageId}/${originalName}`;

  const s3 = createS3Client(inboundConfig.s3);
  await uploadBuffer({
    client: s3,
    bucket: inboundConfig.s3.bucket,
    key: s3Key,
    body: buffer,
    contentType: mime || 'application/octet-stream',
  });

  return buildPublicS3Url(inboundConfig.s3.publicBaseUrl, s3Key);
}

function guessExtension(messageType, json) {
  const mime = String(json?.mimetype || json?.mimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('pdf')) return 'pdf';
  if (messageType === 'audioMessage') return 'ogg';
  if (messageType === 'videoMessage') return 'mp4';
  if (messageType === 'documentMessage') return 'pdf';
  if (messageType === 'imageMessage') return 'jpg';
  return 'bin';
}

export { mapUazapiMessageTypeToEvolution };
