/** Monta payload para f_ingestao_mensagem a partir do webhook Evolution. */
export function buildIngestaoPayload({ conexao, organized }) {
  return {
    conexao: { id: conexao.id },
    contaId: conexao.contaId,
    data: {
      remoteJid: organized.remoteJid,
      lid: organized.lid || '',
      pushName: organized.pushName,
      fromMe: organized.fromMe,
      id: organized.messageId,
      conversation: organized.conversation,
      messageType: organized.messageType,
      arquivoUrl: organized.arquivoUrl,
      mensagemRespondida: organized.mensagemRespondida,
    },
    evolu: {
      server_url: organized.serverUrl,
      instance: organized.instance,
      apikey: organized.apikey,
    },
  };
}

/** Extrai e normaliza campos do body Evolution (nó ORGANIZAR - INFOS). */
export function organizeEvolutionWebhook(body) {
  const data = body?.data || {};
  const key = data.key || {};

  const jids = [key.remoteJidAlt || '', key.remoteJid || ''].filter(Boolean);

  const isValidJid = (jid) => {
    if (!jid) return false;
    const num = jid.split('@')[0];
    return /^\d+$/.test(num) && num.length >= 10 && num.length <= 13;
  };

  let jid = jids.find(isValidJid) || jids[1] || jids[0] || '';
  const sufixo = jid.match(/@.+$/)?.[0] || '';
  let numero = jid.replace(/@.+$/, '').replace(/\D/g, '');

  if (numero.length === 10) {
    const ddd = numero.slice(0, 2);
    const restante = numero.slice(2);
    numero = `${ddd}9${restante}`;
  }

  const remoteJid = numero + sufixo;
  const lid = jids.find((j) => j.endsWith('@lid')) || '';

  return {
    remoteJid,
    lid,
    pushName: key.fromMe === false ? data.pushName ?? null : null,
    fromMe: Boolean(key.fromMe),
    messageId: key.id ?? null,
    conversation:
      data.message?.conversation || data.message?.imageMessage?.caption || data.message?.extendedTextMessage?.text || '',
    messageType: data.messageType || 'conversation',
    source: data.source ?? null,
    serverUrl: body.server_url ?? null,
    instance: body.instance ?? null,
    apikey: body.apikey ?? null,
    mensagemRespondida: data.contextInfo?.stanzaId ?? null,
    arquivoUrl: null,
  };
}

export function isAllowedEvolutionChat(remoteJid) {
  if (!remoteJid) return false;
  return remoteJid.includes('@s.whatsapp.net') || remoteJid.includes('@lid');
}

export function isMediaMessageType(messageType) {
  return ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(
    messageType || '',
  );
}
