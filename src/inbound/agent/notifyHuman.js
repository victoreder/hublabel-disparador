import nodemailer from 'nodemailer';
import {
  fetchConfigEmails,
  fetchEmailsSuperAdmin,
  notificarHumanoWhatsapp,
} from '../../supabase.js';
import { logger } from '../../logger.js';
import { tryAcquireActionLock } from './redis.js';

const QUOTA_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
let lastQuotaNotifyAt = 0;

export function isOpenAiQuotaError(error) {
  const code = String(error?.code || '').toLowerCase();
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    code === 'insufficient_quota' ||
    msg.includes('exceeded your current quota') ||
    msg.includes('insufficient_quota') ||
    msg.includes('check your plan and billing details')
  );
}

export function telefoneFromJid(remoteJid) {
  return String(remoteJid || '')
    .replace('@s.whatsapp.net', '')
    .replace(/\D/g, '');
}

export function getWhatsappsFromItem(item) {
  if (item?.whatsappAtivo === false) return [];
  const raw = [
    ...(Array.isArray(item?.whatsapps) ? item.whatsapps : []),
    item?.whatsapp,
  ];
  return [...new Set(raw.map((n) => String(n ?? '').trim()).filter(Boolean))];
}

export function getEmailsFromItem(item) {
  if (item?.emailAtivo === false) return [];
  const raw = [...(Array.isArray(item?.emails) ? item.emails : []), item?.email];
  return [...new Set(raw.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
}

export function getNotificarItens(agente) {
  return (agente?.notificarHumano?.itens ?? []).filter((item) => {
    if (item?.instrucoes) return true;
    return getWhatsappsFromItem(item).length > 0 || getEmailsFromItem(item).length > 0;
  });
}

export function itemTemDestinoNotificacao(item) {
  return getWhatsappsFromItem(item).length > 0 || getEmailsFromItem(item).length > 0;
}

export function resolveNotificarItem(agente, indice) {
  const itens = getNotificarItens(agente);
  if (!itens.length) return null;
  if (itens.length === 1) return itens[0];

  const idx = Number(indice);
  if (!Number.isInteger(idx) || idx < 0 || idx >= itens.length) return null;
  return itens[idx];
}

export function buildMensagemNotificacao(item, args, job) {
  const vars = {
    nome: job?.nomeContato ?? '',
    telefone: telefoneFromJid(job?.telefone),
    ...(args?.variaveis && typeof args.variaveis === 'object' ? args.variaveis : {}),
  };

  const mensagemInformada = String(args?.mensagem ?? '').trim();
  if (mensagemInformada) return mensagemInformada;

  const modelo = String(item?.modeloMensagem ?? '').trim();
  if (modelo) {
    return modelo.replace(/\[([^\]]+)\]/g, (_, key) => {
      const valor = vars[key.trim()];
      return valor != null && String(valor).trim() !== '' ? String(valor) : `[${key}]`;
    });
  }

  return 'Notificação de atendimento humano';
}

export async function sendNotificationEmail(smtpConfig, { to, subject, text }) {
  if (!smtpConfig?.smtp_host || !smtpConfig?.smtp_user || !smtpConfig?.smtp_apikey) {
    return { ok: false, error: 'SMTP não configurado em SAAS_Config_Emails (id=1)' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpConfig.smtp_host,
      port: Number(smtpConfig.smtp_port) || 587,
      secure: Number(smtpConfig.smtp_port) === 465,
      auth: {
        user: smtpConfig.smtp_user,
        pass: smtpConfig.smtp_apikey,
      },
    });

    await transporter.sendMail({
      from: smtpConfig.smtp_name
        ? `"${smtpConfig.smtp_name}" <${smtpConfig.smtp_email || smtpConfig.smtp_user}>`
        : smtpConfig.smtp_email || smtpConfig.smtp_user,
      to,
      subject,
      text,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function notifyOpenAiSemSaldo({ job, error }) {
  if (!isOpenAiQuotaError(error)) return { ok: false, skipped: true };

  const agora = Date.now();
  if (agora - lastQuotaNotifyAt < QUOTA_NOTIFY_COOLDOWN_MS) {
    logger.info('Aviso de saldo OpenAI ignorado (cooldown)', {
      conversaId: job?.conversaId,
      cooldownMs: QUOTA_NOTIFY_COOLDOWN_MS,
    });
    return { ok: false, skipped: true, reason: 'cooldown' };
  }

  let emails = [];
  try {
    emails = await fetchEmailsSuperAdmin();
  } catch (err) {
    logger.warn('Falha ao buscar e-mails dos super admins para aviso de saldo OpenAI', {
      message: err.message,
    });
    return { ok: false, error: err.message };
  }

  if (!emails.length) {
    logger.warn('Nenhum super admin com e-mail para avisar sobre saldo OpenAI');
    return { ok: false, error: 'Nenhum super admin com e-mail' };
  }

  let smtpConfig = null;
  try {
    smtpConfig = await fetchConfigEmails();
  } catch (err) {
    logger.warn('Falha ao buscar SMTP para aviso de saldo OpenAI', { message: err.message });
    return { ok: false, error: err.message };
  }

  const subject = 'HubLabel — OpenAI sem saldo';
  const text = [
    'Atenção: a API da OpenAI retornou erro de quota/saldo esgotado.',
    '',
    `Conversa ID: ${job?.conversaId ?? '—'}`,
    `Agente ID: ${job?.agenteId ?? '—'}`,
    `Conta ID: ${job?.contaId ?? '—'}`,
    `Telefone: ${job?.telefone ?? '—'}`,
    '',
    `Erro: ${error?.message || String(error)}`,
    '',
    'Verifique o plano e o billing em: https://platform.openai.com/',
  ].join('\n');

  const enviados = [];
  const erros = [];
  for (const email of emails) {
    const envio = await sendNotificationEmail(smtpConfig, { to: email, subject, text });
    if (envio.ok) enviados.push(email);
    else erros.push({ email, error: envio.error });
  }

  if (enviados.length) {
    lastQuotaNotifyAt = agora;
    logger.info('Super admin notificado: OpenAI sem saldo', {
      emails: enviados,
      conversaId: job?.conversaId,
    });
  } else {
    logger.warn('Não foi possível notificar super admin sobre saldo OpenAI', { erros });
  }

  return { ok: enviados.length > 0, enviados, erros };
}

function listWhatsappsRaw(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const raw = [...(Array.isArray(obj.whatsapps) ? obj.whatsapps : []), obj.whatsapp];
  return [...new Set(raw.map((n) => String(n ?? '').trim()).filter(Boolean))];
}

function listEmailsRaw(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const raw = [...(Array.isArray(obj.emails) ? obj.emails : []), obj.email];
  return [...new Set(raw.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
}

/**
 * Destinos reais (número/e-mail), não só flags whatsappAtivo/emailAtivo.
 * Flags sozinhas NÃO contam — senão o dados da ação sobrescreve o item do agente
 * e perde e-mail/WhatsApp configurados no painel.
 */
function temDestinosExplicitosNoArgs(args) {
  return listWhatsappsRaw(args).length > 0 || listEmailsRaw(args).length > 0;
}

export async function executeNotificarHumano({ job, agente, args = {}, redisUrl = null }) {
  const url = redisUrl || process.env.REDIS_URL?.trim() || null;
  const acquired = await tryAcquireActionLock(url, job?.conversaId, 'notificar-humano', 5);
  if (!acquired) {
    logger.info('notificar-humano ignorado (já executado recentemente)', {
      conversaId: job?.conversaId,
    });
    return { success: true, skipped: true, reason: 'duplicate-lock' };
  }

  const itens = getNotificarItens(agente);
  const itemConfig = resolveNotificarItem(agente, args?.indice ?? 0);
  const argsComDestino = temDestinosExplicitosNoArgs(args);

  if (!itemConfig && !argsComDestino) {
    return {
      success: false,
      error:
        itens.length > 1
          ? `Informe indice (0 a ${itens.length - 1}) do item de notificação correto`
          : 'Nenhum item de notificação configurado',
    };
  }

  const base = itemConfig || args;

  // Flags: desliga só se explicitamente false no item ou nos args
  const waAtivo = base?.whatsappAtivo !== false && args?.whatsappAtivo !== false;
  const emailAtivo = base?.emailAtivo !== false && args?.emailAtivo !== false;

  // Destinos: se a ação trouxe número/e-mail, usa; senão usa o item do agente (painel)
  const whatsapps = waAtivo
    ? listWhatsappsRaw(args).length
      ? listWhatsappsRaw(args)
      : getWhatsappsFromItem(base)
    : [];

  const emails = emailAtivo
    ? listEmailsRaw(args).length
      ? listEmailsRaw(args)
      : getEmailsFromItem(base)
    : [];

  if (!whatsapps.length && !emails.length) {
    return {
      success: false,
      error: 'Item de notificação sem WhatsApp ou e-mail ativo',
      debug: {
        temItemConfig: Boolean(itemConfig),
        argsComDestino,
        waAtivo,
        emailAtivo,
        keysArgs: args && typeof args === 'object' ? Object.keys(args) : [],
      },
    };
  }

  const mensagem = buildMensagemNotificacao(base, args, job);
  const assunto = String(base?.assuntoEmail ?? args?.assuntoEmail ?? 'Notificação de atendimento humano').trim();

  const resultado = {
    success: true,
    indice: itemConfig ? itens.indexOf(itemConfig) : null,
    whatsappsEnviados: [],
    emailsEnviados: [],
    erros: [],
  };

  for (const whatsapp of whatsapps) {
    try {
      await notificarHumanoWhatsapp({ job, whatsappDestino: whatsapp, mensagem });
      resultado.whatsappsEnviados.push(whatsapp);
    } catch (error) {
      resultado.erros.push({ canal: 'whatsapp', destino: whatsapp, error: error.message });
      logger.warn('Falha ao notificar WhatsApp — ignorado, agente continua', {
        whatsapp,
        message: error.message,
      });
    }
  }

  if (emails.length) {
    let smtpConfig = null;
    try {
      smtpConfig = await fetchConfigEmails();
    } catch (error) {
      logger.warn('Falha ao buscar SAAS_Config_Emails — e-mails ignorados, agente continua', {
        message: error.message,
      });
      resultado.erros.push({ canal: 'email', destino: null, error: error.message });
    }

    if (smtpConfig && smtpConfig.smtp_host && smtpConfig.smtp_user && smtpConfig.smtp_apikey) {
      for (const email of emails) {
        const envio = await sendNotificationEmail(smtpConfig, { to: email, subject: assunto, text: mensagem });
        if (envio.ok) {
          resultado.emailsEnviados.push(email);
        } else {
          resultado.erros.push({ canal: 'email', destino: email, error: envio.error });
          logger.warn('Falha ao notificar e-mail — ignorado, agente continua', {
            email,
            message: envio.error,
          });
        }
      }
    } else if (emails.length) {
      const aviso = 'SMTP não configurado em SAAS_Config_Emails (id=1)';
      resultado.erros.push({ canal: 'email', destino: null, error: aviso });
      logger.warn(`${aviso} — e-mails ignorados, agente continua`, { emails });
    }
  }

  if (resultado.erros.length) {
    logger.info('Notificação humana concluída com falhas parciais (agente continua)', {
      whatsappsEnviados: resultado.whatsappsEnviados.length,
      emailsEnviados: resultado.emailsEnviados.length,
      erros: resultado.erros.length,
    });
  }

  logger.info('Notificação humana concluída', {
    conversaId: job?.conversaId,
    whatsapps: resultado.whatsappsEnviados.length,
    emails: resultado.emailsEnviados.length,
    erros: resultado.erros.length,
  });

  return resultado;
}

export function buildNotificarHumanoToolSchema(agente) {
  const itens = getNotificarItens(agente).filter(itemTemDestinoNotificacao);
  if (!itens.length) return null;

  const properties = {
    mensagem: {
      type: 'string',
      description:
        'Mensagem para os humanos. Se modeloMensagem estiver configurado, pode omitir e usar variaveis.',
    },
    variaveis: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Valores para substituir no modelo, ex.: nome, telefone',
    },
  };
  const required = [];

  if (itens.length > 1) {
    properties.indice = {
      type: 'integer',
      minimum: 0,
      maximum: itens.length - 1,
      description: 'Índice do item em notificarHumano.itens conforme gatilho/instruções do prompt',
    };
    required.push('indice');
  }

  return {
    type: 'function',
    function: {
      name: 'NOTIFICAR_HUMANO',
      description:
        'Notifica todos os WhatsApps e e-mails configurados no item escolhido. Não altera status da conversa.',
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}
