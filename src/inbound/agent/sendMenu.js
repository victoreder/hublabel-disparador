import { logger } from '../../logger.js';
import { saveMensagemIA, updateConversaUltimaMensagem } from '../../supabase.js';
import { extractUazapiMessageId } from '../../uazapi/client.js';
import { formatMenuAsTexto, labelsDoMenu } from './botoes.js';
import { sendTextReply } from './sendReply.js';

function telefoneDigits(remoteJid) {
  return String(remoteJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
}

async function persistirMenu(job, corpo, menu, messageId) {
  const apiOficial = Boolean(job.envio?.apiOficial);
  const labels = labelsDoMenu(menu);
  const mensagem =
    labels.length > 0 ? `${corpo}\n\nBotões enviados: ${labels.join(' | ')}` : corpo;

  await saveMensagemIA({
    contaId: job.contaId,
    conexaoId: job.conexaoId,
    conversaId: job.conversaId,
    mensagem,
    tipoMensagem: 'conversation',
    arquivoUrl: null,
    ...(apiOficial
      ? { metaMessageId: messageId || null, metaStatus: 'sent' }
      : { messageEvolutionId: messageId || null }),
  });

  Promise.resolve()
    .then(() =>
      updateConversaUltimaMensagem({
        telefone: job.telefone,
        conexaoId: job.conexaoId,
        agenteId: job.agenteId,
      }),
    )
    .catch(() => {});
}

async function enviarMenuUazapi(job, corpo, menu) {
  const { serverUrl, apikey } = job.envio ?? {};
  if (!serverUrl || !apikey) throw new Error('Dados UazAPI ausentes');
  const number = telefoneDigits(job.telefone);
  const res = await fetch(`${String(serverUrl).replace(/\/+$/, '')}/send/menu`, {
    method: 'POST',
    headers: { token: apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number,
      type: menu.tipo === 'list' ? 'list' : 'button',
      text: corpo,
      choices: menu.choices,
      ...(menu.footerText ? { footerText: menu.footerText } : {}),
      ...(menu.listButton ? { listButton: menu.listButton } : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `UazAPI ${res.status}`);
  return json;
}

async function enviarMenuMeta(job, corpo, menu, agentConfig) {
  const { accessToken, phoneNumberId } = job.envio ?? {};
  if (!accessToken || !phoneNumberId) throw new Error('Dados Meta ausentes');
  const to = telefoneDigits(job.telefone);
  const version = agentConfig?.metaGraphApiVersion || 'v25.0';
  const interactive =
    menu.tipo === 'list'
      ? {
          type: 'list',
          body: { text: corpo },
          action: {
            button: (menu.listButton || 'Ver opções').slice(0, 20),
            sections: [
              {
                title: 'Opções',
                rows: menu.choices.slice(0, 10).map((c, i) => {
                  const [title, id] = String(c).split('|');
                  return {
                    id: String(id || i + 1).slice(0, 200),
                    title: String(title || '').slice(0, 24),
                  };
                }),
              },
            ],
          },
        }
      : {
          type: 'button',
          body: { text: corpo },
          action: {
            buttons: menu.choices.slice(0, 3).map((c, i) => {
              const [title, id] = String(c).split('|');
              return {
                type: 'reply',
                reply: {
                  id: String(id || i + 1).slice(0, 256),
                  title: String(title || '').slice(0, 20),
                },
              };
            }),
          },
        };
  if (menu.footerText) interactive.footer = { text: menu.footerText };

  const res = await fetch(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive,
      }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `Meta ${res.status}`);
  return json;
}

/**
 * Envia menu do agente:
 * - API oficial → Meta interactive
 * - Uazapi → POST /send/menu
 * - Evolution → texto com "— opção" (sem botão nativo)
 */
export async function sendAgentMenu(job, texto, menu, agentConfig) {
  const corpo = String(texto || '').trim() || 'Escolha uma opção:';
  const apiOficial = Boolean(job.envio?.apiOficial);
  const provedor = String(job.envio?.provedorApi || '').toLowerCase();

  if (!apiOficial && provedor !== 'uazapi' && job.canal !== 'uazapi') {
    const textoEvo = formatMenuAsTexto(corpo, menu);
    await sendTextReply(job, textoEvo, agentConfig);
    return { evolutionText: true };
  }

  let sendResult;
  if (apiOficial) {
    sendResult = await enviarMenuMeta(job, corpo, menu, agentConfig);
  } else {
    sendResult = await enviarMenuUazapi(job, corpo, menu);
  }

  const messageId =
    sendResult?.key?.id ||
    sendResult?.messages?.[0]?.id ||
    sendResult?.messageId ||
    extractUazapiMessageId(sendResult) ||
    null;

  await persistirMenu(job, corpo, menu, messageId);
  return sendResult;
}

export async function sendAgentMenuOrFallback(job, texto, menu, agentConfig) {
  try {
    return await sendAgentMenu(job, texto, menu, agentConfig);
  } catch (err) {
    logger.warn('Agente: menu falhou — enviando só o texto', {
      conversaId: job?.conversaId,
      message: err.message,
    });
    const corpo = String(texto || '').trim();
    if (corpo) await sendTextReply(job, corpo, agentConfig);
    return { fallbackText: true, error: err.message };
  }
}
