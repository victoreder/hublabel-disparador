import { logger } from '../../../logger.js';
import { saveMensagemIA, updateConversaUltimaMensagem } from '../../../supabase.js';
import { extractUazapiMessageId } from '../../../uazapi/client.js';
import { normalizeMediaType } from '../mediaType.js';
import { classifyChunk } from '../parseResponse.js';
import { sendAgentChunk, sendTextReply } from '../sendReply.js';

function telefoneDigits(remoteJid) {
  return String(remoteJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
}


async function persistirSaida(job, mensagem, tipoMensagem, arquivoUrl, messageId) {
  const apiOficial = Boolean(job.envio?.apiOficial);
  await saveMensagemIA({
    contaId: job.contaId,
    conexaoId: job.conexaoId,
    conversaId: job.conversaId,
    mensagem,
    tipoMensagem: tipoMensagem || 'conversation',
    arquivoUrl: arquivoUrl ?? null,
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

export async function enviarTextoFollowup(job, texto, agentConfig) {
  if (!String(texto || '').trim()) return;
  await sendTextReply(job, texto.trim(), agentConfig);
}

export async function enviarMidiaFollowup(job, tipo, url, caption, agentConfig, mime) {
  const raw = String(url || '').trim();
  if (!raw || raw.startsWith('blob:')) {
    logger.warn('Follow-up: URL de mídia inválida (precisa ser http/https público)', {
      conversaId: job?.conversaId,
      url: raw || null,
    });
    return;
  }
  const type = normalizeMediaType(tipo, raw, mime);
  const markdown = `[(${type})](${raw})`;
  const kind = classifyChunk(markdown);
  await sendAgentChunk(job, { kind, text: markdown }, agentConfig);
  if (caption?.trim()) await sendTextReply(job, caption.trim(), agentConfig);
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

async function enviarMenuEvolution(job, corpo, menu) {
  const { serverUrl, instance, apikey } = job.envio ?? {};
  if (!serverUrl || !instance || !apikey) throw new Error('Dados Evolution ausentes');
  const base = String(serverUrl).replace(/\/+$/, '');
  const number = job.telefone;
  const path =
    menu.tipo === 'list'
      ? `/message/sendList/${instance}`
      : `/message/sendButtons/${instance}`;
  const body =
    menu.tipo === 'list'
      ? {
          number,
          title: corpo.slice(0, 60),
          description: corpo,
          buttonText: menu.listButton || 'Ver opções',
          footerText: menu.footerText || '',
          sections: [
            {
              title: 'Opções',
              rows: menu.choices.map((c, i) => {
                const [title, id] = String(c).split('|');
                return {
                  title: String(title || '').slice(0, 24),
                  rowId: String(id || i + 1),
                };
              }),
            },
          ],
        }
      : {
          number,
          title: corpo.slice(0, 60),
          description: corpo,
          footer: menu.footerText || '',
          buttons: menu.choices.map((c, i) => {
            const [title, id] = String(c).split('|');
            return {
              type: 'reply',
              displayText: String(title || '').slice(0, 20),
              id: String(id || i + 1),
            };
          }),
        };

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `Evolution ${res.status}`);
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

export async function enviarMenuFollowup(job, texto, menu, agentConfig) {
  const corpo = String(texto || '').trim() || 'Escolha uma opção:';
  const apiOficial = Boolean(job.envio?.apiOficial);
  const provedor = String(job.envio?.provedorApi || '').toLowerCase();

  let sendResult;
  try {
    if (apiOficial) sendResult = await enviarMenuMeta(job, corpo, menu, agentConfig);
    else if (provedor === 'uazapi' || job.canal === 'uazapi') {
      sendResult = await enviarMenuUazapi(job, corpo, menu);
    } else {
      sendResult = await enviarMenuEvolution(job, corpo, menu);
    }
  } catch (err) {
    logger.warn('Follow-up: menu falhou — enviando texto', { message: err.message });
    await sendTextReply(job, corpo, agentConfig);
    return;
  }

  const messageId =
    sendResult?.key?.id ||
    sendResult?.messages?.[0]?.id ||
    sendResult?.messageId ||
    extractUazapiMessageId(sendResult) ||
    null;
  await persistirSaida(job, corpo, 'conversation', null, messageId);
}

export async function dispararFakeCallFollowup(job, segundos) {
  const secs = Math.min(120, Math.max(1, Math.floor(Number(segundos) || 15)));
  const { serverUrl, instance, apikey } = job.envio ?? {};
  if (!serverUrl || !apikey || !job.telefone) {
    logger.warn('Follow-up fake call sem conexão/telefone');
    return;
  }
  const base = String(serverUrl).replace(/\/+$/, '');
  const provedor = String(job.envio?.provedorApi || '').toLowerCase();
  try {
    if (provedor === 'uazapi' || job.canal === 'uazapi') {
      const res = await fetch(`${base}/send/call`, {
        method: 'POST',
        headers: { token: apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: telefoneDigits(job.telefone),
          callDuration: secs,
        }),
      });
      if (!res.ok) throw new Error(`UazAPI ${res.status}`);
      return;
    }
    if (!instance) throw new Error('instance ausente');
    const res = await fetch(`${base}/call/offer/${instance}`, {
      method: 'POST',
      headers: { apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: job.telefone, isVideo: false, callDuration: secs }),
    });
    if (!res.ok) throw new Error(`Evolution ${res.status}`);
  } catch (err) {
    logger.warn('Follow-up fake call indisponível', { message: err.message });
  }
}
