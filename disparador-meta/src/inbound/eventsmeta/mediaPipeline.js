import { logger } from '../../logger.js';
import { fetchConexaoForMedia, saveMetaMediaJob } from '../../supabase.js';
import { createS3Client, uploadBuffer } from '../storage/s3.js';

export async function processMediaJob(job, { s3Config, metaGraphApiVersion }) {
  const conexao = await fetchConexaoForMedia(job.phone_number_id, job.waba_id);
  if (!conexao?.access_token) {
    throw new Error(`Conexão não encontrada para mídia (phone=${job.phone_number_id}, waba=${job.waba_id})`);
  }

  const mediaMeta = await fetchMetaMediaUrl(job.media_id, conexao.access_token, metaGraphApiVersion);
  const mediaUrl = mediaMeta?.url;
  if (!mediaUrl) {
    throw new Error(`Meta não retornou URL para media_id ${job.media_id}`);
  }

  const fileBuffer = await downloadMetaFile(mediaUrl, conexao.access_token);
  const s3Key = `meta/${conexao.id}/${job.safe_message_id}.${job.file_ext}`;
  const publicLink = `${s3Config.publicBaseUrl}/${s3Key}`;

  const client = createS3Client(s3Config);
  await uploadBuffer({
    client,
    bucket: s3Config.bucket,
    key: s3Key,
    body: fileBuffer,
    contentType: job.mime_type,
  });

  const result = await saveMetaMediaJob({
    conexaoId: conexao.id,
    contaId: conexao.contaId,
    telefone: job.telefone,
    mensagem: job.mensagem,
    tipo_mensagem: job.tipo_mensagem,
    meta_message_id: job.meta_message_id,
    link: publicLink,
    nome_contato: job.nome_contato,
    mensagemRespondida: job.mensagemRespondida,
  });

  logger.info('Mídia Meta salva no chat', {
    conexaoId: conexao.id,
    metaMessageId: job.meta_message_id,
    link: publicLink,
    mensagemId: result?.mensagemId ?? null,
  });

  return result;
}

async function fetchMetaMediaUrl(mediaId, accessToken, apiVersion) {
  const url = `https://graph.facebook.com/${apiVersion}/${mediaId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Falha ao buscar URL da mídia (${response.status})`);
  }
  return body;
}

async function downloadMetaFile(fileUrl, accessToken) {
  const response = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Falha ao baixar mídia da Meta (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}
