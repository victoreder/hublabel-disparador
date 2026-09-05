import nodemailer from 'nodemailer';

export const MSG_EMAIL_INVALIDO = 'E-mail inválido';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TRANSPORTERS = 50;
const transporters = new Map();

export function isValidEmailAddress(email) {
  const value = String(email || '').trim();
  return Boolean(value) && EMAIL_RE.test(value) && value.length <= 254;
}

export function parseEmailPayload(raw) {
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

export class SmtpSendError extends Error {
  constructor(message, { invalidRecipient = false, statusHttp = null, body = null } = {}) {
    super(message);
    this.name = 'SmtpSendError';
    this.invalidRecipient = invalidRecipient;
    this.statusHttp = statusHttp;
    this.body = body;
  }
}

function isRecipientSmtpFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  const responseCode = Number(error?.responseCode);
  const text = `${error?.message || ''} ${error?.response || ''}`.toLowerCase();

  if (code === 'EENVELOPE') return true;
  if (Array.isArray(error?.rejected) && error.rejected.length > 0) return true;

  const recipientHint =
    text.includes('user unknown') ||
    text.includes('unknown user') ||
    text.includes('no such user') ||
    text.includes('mailbox unavailable') ||
    text.includes('mailbox not found') ||
    text.includes('does not exist') ||
    text.includes('invalid recipient') ||
    text.includes('recipient rejected') ||
    text.includes('recipient address rejected') ||
    text.includes('address rejected') ||
    text.includes('user not found') ||
    text.includes('unrouteable') ||
    text.includes('undeliverable') ||
    text.includes('invalid address');

  if ([550, 551, 553].includes(responseCode) && recipientHint) return true;
  if (responseCode === 550 && (text.includes('mailbox') || text.includes('recipient'))) return true;
  return recipientHint;
}

function transporterKey(remetente) {
  return [
    remetente.id,
    remetente.smtp_host,
    remetente.smtp_port,
    remetente.smtp_user,
    String(remetente.smtp_apikey || '').length,
  ].join(':');
}

function getTransporter(remetente) {
  const key = transporterKey(remetente);
  const cached = transporters.get(key);
  if (cached) return cached;

  const port = Number(remetente.smtp_port) || 587;
  const transporter = nodemailer.createTransport({
    host: String(remetente.smtp_host).trim(),
    port,
    secure: port === 465,
    auth: {
      user: String(remetente.smtp_user).trim(),
      pass: String(remetente.smtp_apikey),
    },
  });

  if (transporters.size >= MAX_TRANSPORTERS) {
    const oldest = transporters.keys().next().value;
    transporters.delete(oldest);
  }
  transporters.set(key, transporter);
  return transporter;
}

export function assertRemetenteSmtp(remetente) {
  if (!remetente) {
    throw new SmtpSendError('Remetente SMTP não encontrado', { statusHttp: 404 });
  }
  const host = String(remetente.smtp_host || '').trim();
  const user = String(remetente.smtp_user || '').trim();
  const email = String(remetente.smtp_email || '').trim();
  const pass = String(remetente.smtp_apikey || '').trim();
  if (!host || !user || !email || !pass) {
    throw new SmtpSendError('Remetente SMTP inválido ou incompleto', { statusHttp: 400 });
  }
}

export async function sendDispatchEmail({ remetente, to, subject, html }) {
  assertRemetenteSmtp(remetente);
  if (!isValidEmailAddress(to)) {
    throw new SmtpSendError(MSG_EMAIL_INVALIDO, { invalidRecipient: true, statusHttp: 400 });
  }

  const fromEmail = String(remetente.smtp_email).trim();
  const fromName = String(remetente.smtp_name || remetente.nome || '').trim();

  try {
    const info = await getTransporter(remetente).sendMail({
      from: fromName ? { name: fromName, address: fromEmail } : fromEmail,
      to: String(to).trim(),
      subject: String(subject || '').trim() || '(sem assunto)',
      html: String(html || ''),
    });

    if (Array.isArray(info.rejected) && info.rejected.length > 0) {
      throw new SmtpSendError(MSG_EMAIL_INVALIDO, {
        invalidRecipient: true,
        statusHttp: 550,
        body: { rejected: info.rejected, response: info.response },
      });
    }

    return {
      messageId: info.messageId ?? null,
      accepted: info.accepted ?? [],
      response: info.response ?? null,
    };
  } catch (error) {
    if (error instanceof SmtpSendError) throw error;
    throw new SmtpSendError(isRecipientSmtpFailure(error) ? MSG_EMAIL_INVALIDO : error.message, {
      invalidRecipient: isRecipientSmtpFailure(error),
      statusHttp: error.responseCode ?? null,
      body: {
        code: error.code ?? null,
        responseCode: error.responseCode ?? null,
        response: error.response ?? null,
      },
    });
  }
}
