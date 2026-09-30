import { logger } from '../../logger.js';
import { fetchMensagemArquivoUrl } from '../../supabase.js';
import { lembrarDescricaoImagem } from './imageInput.js';
import { sendTextReply } from './sendReply.js';

const MEDIA_MESSAGE_TYPES = new Set(['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage']);

async function resolveArquivoUrl(job) {
  if (job.arquivoUrl) return job.arquivoUrl;
  if (!job.mensagemId) return null;
  try {
    return await fetchMensagemArquivoUrl(job.mensagemId);
  } catch (error) {
    logger.warn('Falha ao buscar arquivoUrl da mensagem', {
      mensagemId: job.mensagemId,
      message: error.message,
    });
    return null;
  }
}

async function fetchBufferFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar arquivo: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function transcribeAudio(agentConfig, buffer, filename = 'audio.ogg') {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', agentConfig.whisperModel);
  form.append('language', 'pt');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentConfig.openaiApiKey}` },
    body: form,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || 'Falha na transcrição Whisper');
  }
  return json.text?.trim() || '';
}

async function analyzeImage(agentConfig, buffer, mimeType = 'image/jpeg') {
  const base64 = buffer.toString('base64');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentConfig.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agentConfig.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Descreva de forma objetiva e detalhada o que aparece nesta imagem: objetos, pessoas, produtos, cores, textos visíveis e contexto. Responda apenas com a descrição.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
          ],
        },
      ],
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || 'Falha na análise de imagem');
  }
  return json.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Retorna texto para o agente, ou null para abortar (mensagem fallback já enviada).
 */
export async function preprocessInput(job, agente, agentConfig) {
  const type = job.messageType || 'conversation';
  const texto = job.textoEntrada?.trim() || '';

  if (MEDIA_MESSAGE_TYPES.has(type) && !job.arquivoUrl) {
    job.arquivoUrl = await resolveArquivoUrl(job);
  }

  if (type === 'conversation' || type === 'documentMessage') {
    if ((job.isButtonReply || job.idInterativo) && texto) {
      return `O contato clicou no botão: "${texto}"`;
    }
    return texto || '(mensagem vazia)';
  }

  if (type === 'audioMessage') {
    if (!agente?.ouvirAudio) {
      await sendTextReply(
        job,
        'infelizmente não consigo ouvir audios, pode digitar por favor',
        agentConfig,
      );
      return null;
    }
    if (!job.arquivoUrl) return texto || '(áudio sem URL)';
    try {
      const buffer = await fetchBufferFromUrl(job.arquivoUrl);
      return (await transcribeAudio(agentConfig, buffer)) || '(áudio sem fala detectada)';
    } catch (error) {
      logger.warn('Falha ao transcrever áudio', { message: error.message });
      return texto || '(falha ao transcrever áudio)';
    }
  }

  if (type === 'imageMessage') {
    if (!agente?.analisarImagens) {
      return texto || '(imagem recebida)';
    }
    if (!job.arquivoUrl) return texto || '(imagem sem URL)';
    try {
      const buffer = await fetchBufferFromUrl(job.arquivoUrl);
      const descricao = await analyzeImage(agentConfig, buffer);
      if (!descricao) return texto || '(imagem)';
      lembrarDescricaoImagem(job.conversaId, descricao);
      return texto ? `${descricao}\n\n${texto}` : descricao;
    } catch (error) {
      logger.warn('Falha ao analisar imagem', { message: error.message });
      return texto || '(falha ao analisar imagem)';
    }
  }

  return texto || `(${type})`;
}
