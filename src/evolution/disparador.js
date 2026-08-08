import { logger } from '../logger.js';
import { probeMedia } from './mediaType.js';
import {
  createEvolutionClient,
  classifyEvolutionError,
  EvolutionError,
  isInstanceConnectionOpen,
  isRetryableEvolutionKind,
  mapMessageType,
} from './client.js';
import { ensureContactValidatedForDispatch } from './validarContato.js';
import { isEnderecamentoFallbackError, isLidJid, resolveLidDoTelefone } from './lid.js';
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
        if (isRetryableEvolutionKind(kind) && attempt < config.maxRetries) {
          const delayMs = config.retryDelayMs * (attempt + 1);
          logger.warn('Retry de envio Evolution', {
            detailId: detalhe.id,
            disparoId: detalhe.idDisparo,
            attempt: attempt + 1,
            maxRetries: config.maxRetries,
            kind,
            delayMs,
            message: err instanceof Error ? err.message : String(err),
          });
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Só bloqueia/troca conexão se o estado real da instância não estiver open.
   * Connection Closed / 500 com instância ainda conectada = falha de envio.
   */
  async function shouldSwapForDisconnect(detalhe, kind) {
    if (kind !== 'disconnected' && kind !== 'connectionClosed') return false;

    const instanceName = detalhe.InstanceName;
    if (!instanceName) return true;

    try {
      const statePayload = await evolution.getConnectionState(instanceName);
      const open = isInstanceConnectionOpen(statePayload);
      logger.info('Estado da instância Evolution após falha de envio', {
        detailId: detalhe.id,
        disparoId: detalhe.idDisparo,
        instanceName,
        kind,
        open,
        statePayload,
      });
      return !open;
    } catch (stateErr) {
      logger.warn('Não foi possível verificar connectionState — não bloqueando conexão', {
        detailId: detalhe.id,
        disparoId: detalhe.idDisparo,
        instanceName,
        kind,
        message: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      // Sem confirmação de desconexão: trata como erro de envio, não swap.
      return false;
    }
  }

  /**
   * Contatos com conta migrada para o endereçamento @lid não recebem mensagem pelo telefone
   * (Nack 463). Quando o @lid é conhecido ele vira o destino principal; caso contrário, o
   * telefone é tentado primeiro e o @lid entra como fallback (resolvido on-demand).
   */
  async function sendComFallbackEnderecamento(detalhe, { telefoneDestino, lidDestino, lidAlternativo }) {
    if (isGrupo(detalhe) || !telefoneDestino) {
      const messageType = await sendWithRetry(detalhe, telefoneDestino);
      return { messageType, destinoUsado: getDestino(detalhe, telefoneDestino) };
    }

    const destinos = lidDestino ? [lidDestino, telefoneDestino] : [telefoneDestino];
    const tentados = new Set();
    let ultimoErro;

    while (destinos.length) {
      const destino = destinos.shift();
      if (!destino || tentados.has(destino)) continue;
      tentados.add(destino);

      try {
        const messageType = await sendWithRetry(detalhe, destino);
        return { messageType, destinoUsado: destino };
      } catch (err) {
        if (!isEnderecamentoFallbackError(err)) throw err;
        ultimoErro = err;

        logger.warn('Falha de envio Evolution — tentando outro endereçamento', {
          detailId: detalhe.id,
          disparoId: detalhe.idDisparo,
          destino,
          message: err instanceof Error ? err.message : String(err),
        });

        if (!destinos.length && !isLidJid(destino)) {
          const lidResolvido =
            lidAlternativo ||
            (await resolveLidDoTelefone({
              evolutionClient: evolution,
              instanceName: detalhe.InstanceName,
              telefone: destino,
            }));
          if (lidResolvido) destinos.push(lidResolvido);
        }
      }
    }

    throw ultimoErro;
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

    if (await shouldSwapForDisconnect(detalhe, kind)) {
      await evolutionDb.swapConnection(detalhe.idDisparo, detalhe.idConexao);
      logger.warn('Conexão trocada após desconexão Evolution confirmada', {
        disparoId: detalhe.idDisparo,
        detailId: detalhe.id,
        kind,
        statusHttp,
        respostaHttp,
      });
      return;
    }

    let userMessage = errorMessage;
    if (kind === 'apiError') userMessage = 'Erro na API';
    else if (kind === 'timeout') userMessage = 'Timeout ao enviar mensagem';
    else if (kind === 'offline') userMessage = 'Servidor Evolution indisponivel';
    else if (kind === 'connectionClosed') {
      userMessage = 'Falha transitória de envio (Connection Closed)';
    } else if (kind === 'retryable') {
      userMessage = 'Erro temporário na Evolution';
    } else if (kind === 'disconnected') {
      // Estado ainda open (ou não verificável): não bloquear a conexão.
      userMessage = 'Falha de envio com sinal de desconexão não confirmada';
    }

    await evolutionDb.markFailed(detalhe.id, { userMessage, statusHttp, respostaHttp });
  }

  async function processDetalhe(detalhe) {
    await waitUntil(detalhe.dataEnvio);

    const tipo = String(detalhe.TipoDisparo || '');
    if (tipo !== 'Individual' && tipo !== 'Grupos') return;

    let telefoneDestino = null;
    let idContato = detalhe.idContato;
    let lidDestino = null;
    let lidAlternativo = null;

    if (tipo === 'Individual') {
      const validation = await ensureContactValidatedForDispatch(detalhe, evolution);
      if (!validation.ok) {
        await markInvalidContact(detalhe);
        return;
      }
      telefoneDestino = validation.jid;
      idContato = validation.idContato;
      lidDestino = validation.lid ?? null;
      lidAlternativo = validation.lidAlternativo ?? null;
    }

    try {
      const { messageType, destinoUsado } = await sendComFallbackEnderecamento(detalhe, {
        telefoneDestino,
        lidDestino,
        lidAlternativo,
      });
      await evolutionDb.markSent(detalhe.id);

      if (tipo === 'Individual') {
        const mostrarMensagem = await evolutionDb.fetchMostrarMensagemDisparo(detalhe.idDisparo);
        if (mostrarMensagem) {
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
        } else {
          logger.info('Mensagem do disparo não salva no chat (mostrarMensagem=false)', {
            detailId: detalhe.id,
            disparoId: detalhe.idDisparo,
          });
        }
      }

      logger.info('Mensagem Evolution enviada', {
        detailId: detalhe.id,
        disparoId: detalhe.idDisparo,
        tipo,
        enderecamento: isLidJid(destinoUsado) ? 'lid' : 'telefone',
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
