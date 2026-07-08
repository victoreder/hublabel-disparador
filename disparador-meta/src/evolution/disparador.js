import { logger } from '../logger.js';
import { probeMedia } from './mediaType.js';
import {
  createEvolutionClient,
  classifyEvolutionError,
  EvolutionError,
  mapMessageType,
} from './client.js';
import { ensureContactValidatedForDispatch } from './validarContato.js';
import * as evolutionDb from './supabase.js';

const MSG_INEXISTENTE = 'Contato inexistente';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(dataEnvio) {
  const target = new Date(dataEnvio).getTime();
  if (Number.isNaN(target)) return Promise.resolve();
  const delay = Math.max(0, target - Date.now());
  return delay === 0 ? Promise.resolve() : sleep(delay);
}

function isGrupo(detalhe) {
  return String(detalhe.TipoDisparo || '') === 'Grupos';
}

function getDestino(detalhe, telefoneOverride) {
  if (telefoneOverride) return telefoneOverride;
  if (isGrupo(detalhe)) return detalhe.WhatsAppIdGrupo;
  return detalhe.TelefoneContato;
}

function hasMedia(detalhe) {
  return Boolean(detalhe.KeyRedis && String(detalhe.KeyRedis).trim());
}

function getEvolutionErrorDetails(err) {
  if (err instanceof EvolutionError) {
    return {
      statusHttp: err.status,
      respostaHttp: err.body ?? null,
      errorMessage: err.message,
    };
  }

  return {
    statusHttp: null,
    respostaHttp: null,
    errorMessage: err instanceof Error ? err.message : 'Erro desconhecido ao disparar',
  };
}

export function createDisparadorEvolution(config) {
  const evolution = createEvolutionClient(config);

  async function sendPayload(detalhe, telefoneDestino) {
    const instanceName = detalhe.InstanceName;
    const number = getDestino(detalhe, telefoneDestino);
    const mensagem = detalhe.Mensagem || '';
    const grupo = isGrupo(detalhe);
    const mentionOpts = grupo ? { mentionsEveryOne: Boolean(detalhe.FakeCall) } : {};

    if (!instanceName) throw new Error('InstanceName ausente no detalhe do disparo');
    if (!number) {
      throw new Error(
        grupo ? 'WhatsAppIdGrupo ausente no detalhe' : 'TelefoneContato ausente no detalhe',
      );
    }

    if (!hasMedia(detalhe)) {
      const res = await evolution.sendText(instanceName, number, mensagem, mentionOpts);
      return mapMessageType('conversation', res);
    }

    const media = await probeMedia(detalhe.KeyRedis);

    if (media.mediaType === 'audio') {
      await evolution.sendWhatsAppAudio(instanceName, number, detalhe.KeyRedis, mentionOpts);
      const textRes = await evolution.sendText(instanceName, number, mensagem, mentionOpts);
      return mapMessageType('audio', textRes);
    }

    const mediaRes = await evolution.sendMedia(instanceName, {
      number,
      mediatype: media.mediaType,
      mimetype: media.mimeType,
      caption: mensagem,
      media: detalhe.KeyRedis,
      fileName: media.fileName,
      ...(grupo ? { mentionsEveryOne: Boolean(detalhe.FakeCall) } : {}),
    });

    return mapMessageType(media.mediaType, mediaRes);
  }

  async function sendWithRetry(detalhe, telefoneDestino) {
    let lastError;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      try {
        return await sendPayload(detalhe, telefoneDestino);
      } catch (err) {
        lastError = err;
        const kind = classifyEvolutionError(err);
        if ((kind === 'timeout' || kind === 'offline') && attempt < config.maxRetries) {
          await sleep(config.retryDelayMs);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async function markInvalidContact(detalhe) {
    await evolutionDb.markFailed(detalhe.id, {
      userMessage: MSG_INEXISTENTE,
    });
    logger.info('Disparo marcado como falho — contato inválido', {
      detailId: detalhe.id,
      disparoId: detalhe.idDisparo,
    });
  }

  async function handleFailure(detalhe, err) {
    const kind = classifyEvolutionError(err);
    const { statusHttp, respostaHttp, errorMessage } = getEvolutionErrorDetails(err);

    if (kind === 'disconnected') {
      await evolutionDb.swapConnection(detalhe.idDisparo, detalhe.idConexao);
      logger.warn('Conexão trocada após desconexão Evolution', {
        disparoId: detalhe.idDisparo,
        detailId: detalhe.id,
        statusHttp,
        respostaHttp,
      });
      return;
    }

    let userMessage = errorMessage;
    if (kind === 'apiError') userMessage = 'Erro na API';
    else if (kind === 'timeout') userMessage = 'Timeout ao enviar mensagem';
    else if (kind === 'offline') userMessage = 'Servidor Evolution indisponivel';

    await evolutionDb.markFailed(detalhe.id, { userMessage, statusHttp, respostaHttp });
  }

  async function processDetalhe(detalhe) {
    await waitUntil(detalhe.dataEnvio);

    const tipo = String(detalhe.TipoDisparo || '');
    if (tipo !== 'Individual' && tipo !== 'Grupos') return;

    let telefoneDestino = null;
    let idContato = detalhe.idContato;

    if (tipo === 'Individual') {
      const validation = await ensureContactValidatedForDispatch(detalhe, evolution);
      if (!validation.ok) {
        await markInvalidContact(detalhe);
        return;
      }
      telefoneDestino = validation.jid;
      idContato = validation.idContato;
    }

    try {
      const messageType = await sendWithRetry(detalhe, telefoneDestino);
      await evolutionDb.markSent(detalhe.id);

      if (tipo === 'Individual') {
        try {
          await evolutionDb.salvarMensagemNoChat({
            idContato,
            idConexao: detalhe.idConexao,
            userId: detalhe.UserId,
            mensagem: detalhe.Mensagem,
            urlArquivo: detalhe.KeyRedis || null,
            tipoMensagem: messageType,
          });
        } catch (chatErr) {
          logger.warn('Disparo enviado, mas falhou ao salvar no chat', {
            detailId: detalhe.id,
            message: chatErr instanceof Error ? chatErr.message : String(chatErr),
          });
        }
      }

      logger.info('Mensagem Evolution enviada', {
        detailId: detalhe.id,
        disparoId: detalhe.idDisparo,
        tipo,
      });
    } catch (err) {
      await handleFailure(detalhe, err);
      const { statusHttp, respostaHttp } = getEvolutionErrorDetails(err);
      logger.error('Falha ao enviar Evolution', {
        detailId: detalhe.id,
        disparoId: detalhe.idDisparo,
        tipo,
        message: err instanceof Error ? err.message : String(err),
        statusHttp,
        respostaHttp,
      });
    }
  }

  async function runTick(now = new Date()) {
    const pendentes = await evolutionDb.fetchDisparosEvolutionJanela(now);
    if (pendentes.length === 0) {
      return { total: 0, processados: 0 };
    }
    await Promise.allSettled(pendentes.map((detalhe) => processDetalhe(detalhe)));
    return { total: pendentes.length, processados: pendentes.length };
  }

  return { processDetalhe, runTick };
}
