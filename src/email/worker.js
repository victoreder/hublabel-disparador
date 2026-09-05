import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  claimDetail,
  fetchActiveEmailDisparoIds,
  fetchDisparo,
  fetchPendingDetails,
  fetchRemetenteEmail,
  isDisparoEmailEligible,
  markDetailFailed,
  markDetailSent,
  releaseDetail,
} from '../supabase.js';
import {
  MSG_EMAIL_INVALIDO,
  SmtpSendError,
  parseEmailPayload,
  sendDispatchEmail,
} from './smtp.js';

function parseRespostaHttp(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEmailWorker() {
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
    lastIdleReason: null,
    lastEligibleDisparoIds: null,
  };

  async function start() {
    if (running) return;
    running = true;
    stopped = false;
    logger.info('Worker de e-mail iniciado', {
      sendIntervalMs: config.sendIntervalMs,
      pollIdleMs: config.pollIdleMs,
    });
    loopPromise = runLoop();
  }

  async function stop() {
    stopped = true;
    if (loopPromise) await loopPromise;
    running = false;
    logger.info('Worker de e-mail parado');
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
        logger.error('Erro no loop do worker de e-mail', { message: error.message, stack: error.stack });
        await sleep(config.pollIdleMs);
      }
    }
  }

  async function processNext() {
    const disparoIds = await fetchActiveEmailDisparoIds();
    if (!disparoIds.length) {
      stats.lastIdleReason = 'sem_disparos_email_elegiveis';
      stats.lastEligibleDisparoIds = null;
      return false;
    }

    const candidates = await fetchPendingDetails(disparoIds, 1);
    if (!candidates.length) {
      stats.lastIdleReason = 'sem_detalhes_pending_na_janela';
      stats.lastEligibleDisparoIds = disparoIds.slice(0, 20);
      return false;
    }

    stats.lastIdleReason = null;
    stats.lastEligibleDisparoIds = null;

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
      if (!isDisparoEmailEligible(disparo)) {
        await releaseDetail(detail.id);
        stats.skipped += 1;
        logger.info('Detalhe de e-mail liberado — disparo inativo, expirado ou não é Email', {
          detailId: detail.id,
          disparoId: detail.idDisparo,
          tipoDisparo: disparo?.TipoDisparo ?? null,
          statusDisparo: disparo?.StatusDisparo ?? null,
        });
        return;
      }

      const result = await sendEmailDetail(detail);

      await markDetailSent(detail.id, {
        statusHttp: 250,
        respostaHttp: {
          ...parseRespostaHttp(detail.respostaHttp),
          messageId: result.messageId,
          accepted: result.accepted,
          response: result.response,
          email: result.email,
          remetenteId: result.remetenteId,
        },
      });

      stats.sent += 1;
      logger.info('E-mail enviado', {
        detailId: detail.id,
        disparoId: detail.idDisparo,
        email: result.email,
        messageId: result.messageId,
      });
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error.message;

      const smtpError = error instanceof SmtpSendError ? error : null;
      const mensagemErro = smtpError?.invalidRecipient ? MSG_EMAIL_INVALIDO : error.message;

      await markDetailFailed(detail.id, {
        statusHttp: smtpError?.statusHttp ?? null,
        mensagemErro,
        respostaHttp: {
          ...parseRespostaHttp(detail.respostaHttp),
          ...(smtpError?.body ?? {}),
        },
      });

      logger.error('Falha ao enviar e-mail', {
        detailId: detail.id,
        disparoId: detail.idDisparo,
        message: error.message,
        mensagemErro,
        emailInvalido: Boolean(smtpError?.invalidRecipient),
        statusHttp: smtpError?.statusHttp ?? null,
      });
    }
  }

  return { start, stop, getStats };
}

async function sendEmailDetail(detail) {
  const payload = parseEmailPayload(detail.Payload);
  const email = String(payload.email || '').trim();
  const assunto = String(payload.assunto || '').trim();
  const html = String(payload.html || detail.Mensagem || '').trim();
  const remetenteId = payload.remetenteId;

  if (!email) {
    throw new SmtpSendError(MSG_EMAIL_INVALIDO, { invalidRecipient: true, statusHttp: 400 });
  }
  if (!assunto) {
    throw new SmtpSendError('Assunto ausente no payload do detalhe', { statusHttp: 400 });
  }
  if (!html) {
    throw new SmtpSendError('HTML ausente no detalhe', { statusHttp: 400 });
  }
  if (remetenteId == null || remetenteId === '') {
    throw new SmtpSendError('remetenteId ausente no payload do detalhe', { statusHttp: 400 });
  }

  const remetente = await fetchRemetenteEmail(remetenteId);
  const result = await sendDispatchEmail({ remetente, to: email, subject: assunto, html });
  return { ...result, email, remetenteId };
}
