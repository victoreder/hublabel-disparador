import { saveMensagemIA, updateConversaUltimaMensagem } from '../../supabase.js';
import { logger } from '../../logger.js';
import { stripActionMarkers } from './parseActions.js';
import {
  classifyChunk,
  extractMediaUrl,
  fileNameFromUrl,
  guessMimeFromUrl,
  plainTextFromChunk,
} from './parseResponse.js';

function telefoneDigits(remoteJid) {
  return String(remoteJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
}

async function evolutionRequest(job, path, body) {
  const { serverUrl, instance, apikey } = job.envio ?? {};
  if (!serverUrl || !instance || !apikey) {
    throw new Error('Dados Evolution ausentes no job');
  }

  const baseUrl = serverUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      apikey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(json?.message || json?.error || `Evolution HTTP ${response.status}`);
  }
  return json;
}

async function metaRequest(job, payload, agentConfig) {
  const { accessToken, phoneNumberId } = job.envio ?? {};
  if (!accessToken || !phoneNumberId) {
    throw new Error('Dados Meta ausentes no job');
  }

  const response = await fetch(
    `https://graph.facebook.com/${agentConfig.metaGraphApiVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json.error?.message || `Meta HTTP ${response.status}`);
  }
  return json;
}

function buildMetaPayload(to, type, data) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type,
  };
  payload[type] = data;
  return payload;
}

export async function sendTextReply(job, text, agentConfig) {
  return sendAgentChunk(job, { kind: 'text', text }, agentConfig);
}

export async function sendAgentChunk(job, chunk, agentConfig) {
  const kind = chunk.kind || classifyChunk(chunk.text);
  const text = stripActionMarkers(chunk.text);
  if (!text) return null;

  const apiOficial = Boolean(job.envio?.apiOficial);
  const number = job.telefone;
  const to = telefoneDigits(number);

  let sendResult;
  let mensagemSalvar;
  let tipoMensagem = 'conversation';
  let arquivoUrl = null;

  if (apiOficial) {
    sendResult = await sendMetaChunk(job, kind, text, to, agentConfig);
  } else {
    sendResult = await sendEvolutionChunk(job, kind, text, number);
  }

  if (kind === 'text') {
    mensagemSalvar = plainTextFromChunk(text);
    tipoMensagem = 'conversation';
  } else {
    arquivoUrl = extractMediaUrl(text);
    mensagemSalvar = plainTextFromChunk(text) || `[${kind}]`;
    tipoMensagem =
      kind === 'image'
        ? 'imageMessage'
        : kind === 'video'
          ? 'videoMessage'
          : kind === 'audio'
            ? 'audioMessage'
            : 'documentMessage';
  }

  const messageId =
    sendResult?.key?.id ||
    sendResult?.messages?.[0]?.id ||
    sendResult?.messageId ||
    null;

  await saveMensagemIA({
    contaId: job.contaId,
    conexaoId: job.conexaoId,
    conversaId: job.conversaId,
    mensagem: mensagemSalvar,
    tipoMensagem,
    arquivoUrl,
    messageEvolutionId: messageId,
  });

  await updateConversaUltimaMensagem({
    telefone: job.telefone,
    conexaoId: job.conexaoId,
    agenteId: job.agenteId,
  });

  return { messageId, mensagem: mensagemSalvar, tipoMensagem, arquivoUrl };
}

async function sendEvolutionChunk(job, kind, text, number) {
  const instance = job.envio.instance;

  if (kind === 'text') {
    return evolutionRequest(job, `/message/sendText/${instance}`, {
      number,
      text,
      delay: 1000,
    });
  }

  const mediaUrl = extractMediaUrl(text);
  if (!mediaUrl) {
    return evolutionRequest(job, `/message/sendText/${instance}`, {
      number,
      text: plainTextFromChunk(text) || text,
      delay: 1000,
    });
  }

  if (kind === 'audio') {
    return evolutionRequest(job, `/message/sendWhatsAppAudio/${instance}`, {
      number,
      audio: mediaUrl,
    });
  }

  const mediatype = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'document';
  const body = { number, mediatype, media: mediaUrl };

  if (mediatype === 'document') {
    body.mimetype = guessMimeFromUrl(mediaUrl);
    body.fileName = fileNameFromUrl(mediaUrl);
  }

  return evolutionRequest(job, `/message/sendMedia/${instance}`, body);
}

async function sendMetaChunk(job, kind, text, to, agentConfig) {
  if (kind === 'text') {
    return metaRequest(
      job,
      buildMetaPayload(to, 'text', { body: plainTextFromChunk(text) || text }),
      agentConfig,
    );
  }

  const mediaUrl = extractMediaUrl(text);
  if (!mediaUrl) {
    return metaRequest(
      job,
      buildMetaPayload(to, 'text', { body: plainTextFromChunk(text) || text }),
      agentConfig,
    );
  }

  if (kind === 'image') {
    return metaRequest(job, buildMetaPayload(to, 'image', { link: mediaUrl }), agentConfig);
  }
  if (kind === 'video') {
    return metaRequest(job, buildMetaPayload(to, 'video', { link: mediaUrl }), agentConfig);
  }
  if (kind === 'audio') {
    return metaRequest(job, buildMetaPayload(to, 'audio', { link: mediaUrl }), agentConfig);
  }

  return metaRequest(
    job,
    buildMetaPayload(to, 'document', {
      link: mediaUrl,
      filename: fileNameFromUrl(mediaUrl),
    }),
    agentConfig,
  );
}

export async function notifyTokenUsage(job, agentConfig) {
  if (!agentConfig.calcularTokenUrl) return;
  try {
    await fetch(agentConfig.calcularTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idAgente: job.agenteId,
        telefone: job.telefone,
        origem: 'disparador-inbound',
      }),
    });
  } catch (error) {
    logger.warn('Falha ao notificar tokens', { message: error.message });
  }
}
