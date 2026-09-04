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

  if (isMediaMessageType(organized.messageType) && !organized.arquivoUrl && !organized.isButtonReply) {
    organized.arquivoUrl = await processUazapiMedia(organized, inboundConfig).catch(
      (error) => {
        logger.warn('Falha ao processar midia UazAPI', { message: error.message });
        return null;
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

async function processUazapiMedia(organized, inboundConfig) {
  if (!organized.serverUrl || !organized.apikey || !organized.messageId) {
    return organized.arquivoUrl || null;
  }

  if (organized.arquivoUrl && /^https?:\/\//i.test(organized.arquivoUrl)) {
    return organized.arquivoUrl;
  }

  const client = createUazapiClient({
    baseUrl: organized.serverUrl,
    instanceToken: organized.apikey,
  });

  const json = await client.downloadMessage({
    id: organized.messageId,
    return_base64: true,
    return_link: true,
  });

  const fileUrl = json?.fileURL || json?.url || json?.link || null;
  if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
    return fileUrl;
  }

  const base64 = json?.base64 || json?.data || null;
  if (!base64) {
    throw new Error('UazAPI nao retornou midia');
  }

  const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  const ext = guessExtension(organized.messageType, json);
  const safeMessageId = String(organized.messageId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const originalName = withFileExtension(
    sanitizeS3FileName(null, `${safeMessageId}.${ext}`),
    ext,
  );
  const s3Key = `uazapi/${organized.instance || 'inst'}/${safeMessageId}/${originalName}`;

  const s3 = createS3Client(inboundConfig.s3);
  await uploadBuffer({
    client: s3,
    bucket: inboundConfig.s3.bucket,
    key: s3Key,
    body: buffer,
    contentType: json?.mimetype || json?.mimeType || 'application/octet-stream',
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
