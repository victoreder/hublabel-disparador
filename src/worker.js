import { config } from './config.js';
import { logger } from './logger.js';
import { buildTemplateChatPreview } from './chatMessage.js';
import { MetaApiError, isRecipientPhoneError, sendTemplateMessage, sendWithRetries } from './meta.js';
import { formatPhoneForLog, getPhoneCandidatesForMeta, normalizePhone } from './phone.js';
import { buildMetaTemplateMessage, buildTemplateComponents } from './template.js';
import {
  resolveTemplatePayload,
  parseTemplateComponentes,
  extractVariableIndexes,
  getComponentText,
} from './resolvePayload.js';
import {
  ensureContactValidatedForMetaDispatch,
  MSG_INEXISTENTE as MSG_CONTATO_INEXISTENTE,
} from './validarContatoMeta.js';
import {
  claimDetail,
  fetchCamposPersonalizados,
  fetchConexao,
  fetchContato,
  fetchContatoValoresCampos,
  fetchDisparo,
  fetchActiveDisparoIds,
  fetchPendingDetails,
  fetchTemplateMeta,
  isDisparoEligible,
  markDetailFailed,
  markDetailSent,
  releaseDetail,
  saveTemplateMessageToChat,
} from './supabase.js';

export function createWorker() {
  let running = false;
  let stopped = false;
  let loopPromise = null;

  const stats = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    lastActivityAt: null,
    lastError: null,
  };

  async function start() {
    if (running) return;
    running = true;
    stopped = false;
    logger.info('Worker iniciado', {
      sendIntervalMs: config.sendIntervalMs,
      pollIdleMs: config.pollIdleMs,
      maxRetries: config.maxRetries,
      metaGraphApiVersion: config.metaGraphApiVersion,
    });
    loopPromise = runLoop();
  }

  async function stop() {
    stopped = true;
    if (loopPromise) await loopPromise;
    running = false;
    logger.info('Worker parado');
  }

  function getStats() {
    return { ...stats, running };
  }

  async function runLoop() {
    while (!stopped) {
      try {
        const didWork = await processNext();
        stats.lastActivityAt = new Date().toISOString();
        if (!didWork) {
          await sleep(config.pollIdleMs);
        }
      } catch (error) {
        stats.lastError = error.message;
        logger.error('Erro no loop do worker', { message: error.message, stack: error.stack });
        await sleep(config.pollIdleMs);
      }
    }
  }

  async function processNext() {
    const disparoIds = await fetchActiveDisparoIds();
    if (!disparoIds.length) return false;

    const candidates = await fetchPendingDetails(disparoIds, 1);
    if (!candidates.length) return false;

    const candidate = candidates[0];
    if (stopped) return true;

    const claimed = await claimDetail(candidate.id);
    if (!claimed) return false;

    await processClaimedDetail(claimed);
    await sleep(config.sendIntervalMs);
    return true;
  }

  async function processClaimedDetail(detail) {
    stats.processed += 1;

    try {
      const disparo = await fetchDisparo(detail.idDisparo);
      if (!isDisparoEligible(disparo)) {
        await releaseDetail(detail.id);
        stats.skipped += 1;
        logger.info('Detalhe liberado — disparo inativo, expirado, não é apioficial ou agendado no futuro', {
          detailId: detail.id,
          disparoId: detail.idDisparo,
          tipoDisparo: disparo?.TipoDisparo ?? null,
          statusDisparo: disparo?.StatusDisparo ?? null,
        });
        return;
      }

      const result = await sendDetail(detail);

      const metaMessageId = result.body?.messages?.[0]?.id ?? null;

      await markDetailSent(detail.id, {
        statusHttp: result.status,
        respostaHttp: {
          ...result.body,
          metaMessageId,
          _phoneUsed: result.phoneUsed,
          _phoneOriginal: result.phoneOriginal,
        },
      });
      if (metaMessageId && result.chat) {
        try {
          const chatResult = await saveTemplateMessageToChat({
            conexaoId: detail.idConexao,
            contaId: result.contaId,
            // Sempre o telefone do contato no banco — phoneUsed pode ser variante com/sem 9 só para a Meta.
            telefone: result.phoneOriginal || result.phoneUsed,
            mensagem: result.chat.mensagem,
            tipoMensagem: result.chat.tipoMensagem,
            metaMessageId,
            arquivoUrl: result.chat.arquivoUrl,
            nomeContato: result.nomeContato,
          });
          logger.info('Template salvo no chat', {
            detailId: detail.id,
            conversaId: chatResult?.conversaId ?? null,
            mensagemId: chatResult?.mensagemId ?? null,
            tipoMensagem: result.chat.tipoMensagem,
          });
        } catch (chatError) {
          logger.warn('Disparo enviado, mas falhou ao salvar no chat', {
            detailId: detail.id,
            message: chatError.message,
          });
        }
      }

      stats.sent += 1;
      logger.info('Mensagem enviada', {
        detailId: detail.id,
        disparoId: detail.idDisparo,
        metaMessageId,
        telefone: formatPhoneForLog(result.phoneUsed),
      });
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error.message;

      const statusHttp = error instanceof MetaApiError ? error.status : null;
      const respostaHttp = error instanceof MetaApiError ? error.body : null;

      await markDetailFailed(detail.id, {
        statusHttp,
        mensagemErro: error.message,
        respostaHttp,
      });

      logger.error('Falha ao enviar mensagem', {
        detailId: detail.id,
        disparoId: detail.idDisparo,
        message: error.message,
        statusHttp,
      });
    }
  }

  return { start, stop, getStats };
}

async function sendDetail(detail) {
  if (!detail.idConexao) {
    throw new Error('Detalhe sem idConexao');
  }

  const templateId = Number.parseInt(String(detail.Mensagem ?? '').trim(), 10);
  if (!Number.isFinite(templateId)) {
    throw new Error(`Mensagem deve conter o id numérico do template (recebido: ${detail.Mensagem})`);
  }

  const contato = await fetchContato(detail.idContato);
  const [conexao, template, valoresCampos, camposPersonalizados] = await Promise.all([
    fetchConexao(detail.idConexao),
    fetchTemplateMeta(templateId),
    fetchContatoValoresCampos(detail.idContato),
    contato?.contaId ? fetchCamposPersonalizados(contato.contaId) : Promise.resolve([]),
  ]);

  if (!conexao) throw new Error(`Conexão ${detail.idConexao} não encontrada`);
  if (!conexao.apiOficial) throw new Error(`Conexão ${detail.idConexao} não é API Oficial`);
  if (!conexao.access_token || !conexao.phone_number_id) {
    throw new Error(`Conexão ${detail.idConexao} sem access_token ou phone_number_id`);
  }

  if (!contato) throw new Error(`Contato ${detail.idContato} não encontrado`);

  if (!template) throw new Error(`Template ${templateId} não encontrado em SAAS_Templates_Meta`);
  if (!template.nome) throw new Error(`Template ${templateId} sem nome`);

  const validation = await ensureContactValidatedForMetaDispatch({
    contato,
    conexao,
    detailId: detail.id,
  });
  if (!validation.ok) {
    throw new Error(validation.reason || MSG_CONTATO_INEXISTENTE);
  }

  let contatoEnvio = contato;
  if (validation.idContato && validation.idContato !== contato.id) {
    contatoEnvio = (await fetchContato(validation.idContato)) || contato;
  }

  const { candidates: phoneCandidates, resolution: phoneResolution } = getPhoneCandidatesForDetail(
    validation.phone || contatoEnvio.telefone,
    detail.respostaHttp,
    { validatedPhone: validation.phone },
  );
  if (!phoneCandidates.length) {
    throw new Error(`Telefone inválido para contato ${validation.idContato || detail.idContato}`);
  }

  if (phoneResolution && phoneResolution.phone !== phoneResolution.original) {
    logger.info('Telefone BR ajustado antes do envio', {
      contatoId: validation.idContato || detail.idContato,
      original: phoneResolution.original,
      enviando: phoneResolution.phone,
      acao: phoneResolution.action,
    });
  }

  if (phoneResolution?.action === 'webhook-retry') {
    logger.info('Reenvio após webhook failed (131026) com telefone alternativo', {
      detailId: detail.id,
      telefoneAnterior: detail.respostaHttp?._phoneUsedBeforeRetry ?? null,
      telefoneOverride: phoneResolution.phone,
    });
  }

  const payload = resolveTemplatePayload({
    templateComponentes: template.componentes,
    templateVariaveisCampos: template.variaveisCampos,
    contato: contatoEnvio,
    valoresCampos,
    camposPersonalizados,
  });

  const { components: templateParts } = parseTemplateComponentes(template.componentes);
  const bodyComponent = templateParts.find((c) => String(c?.type || '').toUpperCase() === 'BODY');
  const requiredBodyVars = extractVariableIndexes(getComponentText(bodyComponent));
  if (requiredBodyVars.length > 0 && (!payload.body || payload.body.length < requiredBodyVars.length)) {
    throw new Error(
      `Template exige ${requiredBodyVars.length} variável(is) no body; variaveisCampos resolveu ${payload.body?.length ?? 0}`,
    );
  }

  const components = buildTemplateComponents(payload, detail.KeyRedis);
  const chat = buildTemplateChatPreview(template.componentes, payload, detail.KeyRedis, template.nome);
  if (!chat.mensagem || chat.usadoFallbackNome) {
    logger.warn('Preview do template sem BODY.text em SAAS_Templates_Meta.componentes', {
      detailId: detail.id,
      templateId,
      templateNome: template.nome,
      componentesVazios: templateParts.length === 0,
      mensagemPreview: chat.mensagem,
    });
  }
  const contaId = conexao.contaId || contatoEnvio.contaId;
  if (!contaId) {
    throw new Error(`Conta não encontrada para conexão ${detail.idConexao} / contato ${detail.idContato}`);
  }

  let lastError;
  for (let i = 0; i < phoneCandidates.length; i += 1) {
    const phone = phoneCandidates[i];
    const metaPayload = buildMetaTemplateMessage({
      phone,
      templateName: template.nome,
      language: template.idioma,
      components,
    });

    try {
      const result = await sendWithRetries(
        () =>
          sendTemplateMessage({
            phoneNumberId: conexao.phone_number_id,
            accessToken: conexao.access_token,
            payload: metaPayload,
          }),
        { maxRetries: config.maxRetries },
      );

      if (i > 0) {
        logger.info('Enviado com variante alternativa de telefone', {
          detailId: detail.id,
          tentativa: phoneCandidates[0],
          usado: phone,
        });
      }

      return {
        ...result,
        phoneUsed: phone,
        phoneOriginal:
          phoneResolution?.original ??
          normalizePhone(contatoEnvio.telefone) ??
          validation.phone,
        phoneVariantIndex: i,
        chat,
        contaId,
        nomeContato: contatoEnvio.nome ?? null,
      };
    } catch (error) {
      lastError = error;
      const hasAlternate = i < phoneCandidates.length - 1;
      if (hasAlternate && isRecipientPhoneError(error)) {
        logger.warn('Falha no telefone, tentando variante BR (nono dígito)', {
          detailId: detail.id,
          telefone: formatPhoneForLog(phone),
          message: error.message,
          proximo: formatPhoneForLog(phoneCandidates[i + 1]),
        });
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error('Falha ao enviar: nenhuma variante de telefone funcionou');
}

function getPhoneCandidatesForDetail(rawPhone, respostaHttp, { validatedPhone } = {}) {
  const override = normalizePhone(respostaHttp?._phoneOverride);
  if (override) {
    return {
      candidates: [override],
      resolution: {
        phone: override,
        action: 'webhook-retry',
        original: normalizePhone(respostaHttp?._phoneUsedBeforeRetry ?? rawPhone),
      },
    };
  }

  const verified = normalizePhone(validatedPhone);
  if (verified) {
    return {
      candidates: [verified],
      resolution: {
        phone: verified,
        action: 'meta-validated',
        original: normalizePhone(rawPhone) || verified,
      },
    };
  }

  return getPhoneCandidatesForMeta(rawPhone);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
