import { logger } from '../../logger.js';
import { fetchConexaoById, ingestaoMensagem } from '../../supabase.js';
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
import {
  buildIngestaoPayload,
  extractOriginalFileName,
  isAllowedEvolutionChat,
  isMediaMessageType,
  organizeEvolutionWebhook,
} from './organize.js';

export async function handleEvolutionWebhook(req, inboundConfig) {
  const body = req.body ?? {};
  const idConexao = Number.parseInt(String(req.query?.idConexao ?? body?.idConexao ?? ''), 10);

  if (!Number.isFinite(idConexao)) {
    return { status: 400, body: { ok: false, error: 'idConexao obrigatorio na query' } };
  }

  const data = body.data ?? {};
  if (data.messageType === 'reactionMessage' || data.message?.reactionMessage) {
    return { status: 200, body: { ok: true, ignored: 'reaction' } };
  }

  const organized = organizeEvolutionWebhook(body);
  if (!isAllowedEvolutionChat(organized.remoteJid)) {
    return { status: 200, body: { ok: true, ignored: 'group_or_invalid_jid' } };
  }

  const conexao = await fetchConexaoById(idConexao);
  if (!conexao) {
    return { status: 404, body: { ok: false, error: 'conexao nao encontrada' } };
  }

  if (isMediaMessageType(organized.messageType)) {
    organized.arquivoUrl = await processEvolutionMedia(body, organized, inboundConfig).catch((error) => {
      logger.warn('Falha ao processar midia Evolution', { message: error.message });
      return null;
    });
  }

  const payload = buildIngestaoPayload({ conexao, organized });
  const resultado = await ingestaoMensagem(payload);

  if (resultado?.ok === false) {
    logger.warn('f_ingestao_mensagem retornou erro', { error: resultado.error, conexaoId: idConexao });
    return { status: 200, body: resultado };
  }

  if (resultado?.contatoId && !organized.fromMe) {
    scheduleContatoFotoPerfilSync({
      contatoId: resultado.contatoId,
      contatoCriado: Boolean(resultado.contatoCriado),
      telefone: organized.remoteJid,
      fromMe: organized.fromMe,
      canal: 'evolution',
      conexaoId: idConexao,
      contaId: conexao.contaId,
      conexao,
      evolution: payload.evolu,
      s3Config: inboundConfig.s3,
    });
  }

  if (resultado?.segueFluxoIA) {
    const job = buildAgentJobFromIngestao({
      canal: 'evolution',
      resultado,
      organized,
      conexao,
    });
    enqueueAgentJob(job);
  }

  return { status: 200, body: { ok: true, segueFluxoIA: Boolean(resultado?.segueFluxoIA) } };
}

async function processEvolutionMedia(body, organized, inboundConfig) {
  if (!organized.serverUrl || !organized.instance || !organized.apikey || !organized.messageId) {
    return null;
  }

  const baseUrl = organized.serverUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/getBase64FromMediaMessage/${organized.instance}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: organized.apikey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { key: { id: organized.messageId } },
      convertToMp4: organized.messageType === 'videoMessage',
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.base64) {
    throw new Error('Evolution nao retornou base64 da midia');
  }

  const buffer = Buffer.from(json.base64, 'base64');
  const ext = guessExtension(organized.messageType, json);
  const safeMessageId = organized.messageId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const originalFileName =
    extractOriginalFileName(json) || organized.arquivoNomeOriginal || extractOriginalFileName(body);
  const originalName = withFileExtension(
    sanitizeS3FileName(originalFileName, `${safeMessageId}.${ext}`),
    ext,
  );
  const s3Key = `evo/${organized.instance}/${safeMessageId}/${originalName}`;

  const client = createS3Client(inboundConfig.s3);
  await uploadBuffer({
    client,
    bucket: inboundConfig.s3.bucket,
    key: s3Key,
    body: buffer,
    contentType: json.mimetype || 'application/octet-stream',
  });

  return buildPublicS3Url(inboundConfig.s3.publicBaseUrl, s3Key);
}

function guessExtension(messageType, json) {
  const mime = String(json?.mimetype || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('msword')) return 'doc';
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime.includes('ms-excel')) return 'xls';
  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime.includes('ms-powerpoint')) return 'ppt';
  if (mime.includes('presentationml')) return 'pptx';
  if (mime.includes('zip')) return 'zip';
  if (mime.includes('csv')) return 'csv';
  if (mime.includes('plain')) return 'txt';
  if (messageType === 'audioMessage') return 'ogg';
  if (messageType === 'videoMessage') return 'mp4';
  if (messageType === 'documentMessage') return 'pdf';
  return 'bin';
}
