import { mapUazapiMessageTypeToEvolution } from '../../uazapi/client.js';

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function ensurePhoneJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const digits = digitsOnly(raw);
  if (!digits) return '';
  let numero = digits;
  if (numero.length === 10) {
    numero = `${numero.slice(0, 2)}9${numero.slice(2)}`;
  }
  return `${numero}@s.whatsapp.net`;
}

function ensureLidJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.endsWith('@lid')) return raw;
  if (/^\d+$/.test(raw)) return `${raw}@lid`;
  return '';
}

/** Detecta payload UazAPI (formato EventType ou event=messages). */
export function isUazapiWebhookShape(body = {}) {
  if (!body || typeof body !== 'object') return false;
  if (body.EventType || body.message || body.chat) return true;
  const event = String(body.event || '').toLowerCase();
  return event === 'messages' || event === 'messages_update' || event === 'connection';
}

export function organizeUazapiWebhook(body, conexao = {}) {
  const message = body?.message || body?.data?.message || body?.data || {};
  const chat = body?.chat || body?.data?.chat || {};

  const senderPn =
    message.sender_pn ||
    chat.phone ||
    chat.wa_chatid ||
    message.sender ||
    chat.id ||
    '';
  const senderLid = message.sender_lid || '';

  const remoteJid = ensurePhoneJid(senderPn) || ensureLidJid(senderLid);
  const lid = ensureLidJid(senderLid);

  const text =
    (typeof message.text === 'string' && message.text) ||
    (typeof message.content === 'string' && message.content) ||
    message.content?.text ||
    '';

  const messageType = mapUazapiMessageTypeToEvolution(message);
  const messageId = message.messageid || message.id || null;

  return {
    remoteJid,
    lid,
    pushName:
      message.fromMe === true
        ? null
        : message.senderName || chat.name || chat.wa_name || chat.wa_contactName || null,
    fromMe: Boolean(message.fromMe),
    messageId,
    conversation: text,
    messageType,
    arquivoNomeOriginal: null,
    source: message.source || 'uazapi',
    serverUrl: body.BaseUrl || conexao.urlApi || null,
    instance: conexao.instanceName || body.instance || null,
    apikey: body.token || conexao.Apikey || null,
    mensagemRespondida: message.quoted || null,
    arquivoUrl: message.fileURL || message.fileUrl || null,
    isGroup: Boolean(message.isGroup || chat.wa_isGroup),
    provedorApi: 'uazapi',
  };
}

export function isAllowedUazapiChat(organized) {
  if (!organized?.remoteJid) return false;
  if (organized.isGroup) return false;
  return (
    organized.remoteJid.includes('@s.whatsapp.net') ||
    organized.remoteJid.includes('@lid')
  );
}

export function buildIngestaoPayloadUazapi({ conexao, organized }) {
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
