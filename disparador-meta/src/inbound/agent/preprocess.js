import { logger } from '../../logger.js';
import { sendTextReply } from './sendReply.js';

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
              text: 'analise os elementos da imagem e detalhe o que está vendo.\nAntes da sua descrição de imagem informe, o usuário enviou uma imagem com esse descritivo, conitnua a conversa, como quem viu a imagem',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
          ],
        },
      ],
      max_tokens: 800,
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

  if (type === 'conversation' || type === 'documentMessage') {
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
      return (await analyzeImage(agentConfig, buffer)) || texto || '(imagem)';
    } catch (error) {
      logger.warn('Falha ao analisar imagem', { message: error.message });
      return texto || '(falha ao analisar imagem)';
    }
  }

  return texto || `(${type})`;
}
