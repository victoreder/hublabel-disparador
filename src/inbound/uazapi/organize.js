import { mapUazapiMessageTypeToEvolution } from '../../uazapi/client.js';

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function ensurePhoneJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) {
    if (raw.includes('@g.us')) return raw;
    if (raw.includes('@lid') || raw.includes('@s.whatsapp.net')) return raw;
    const digits = digitsOnly(raw.split('@')[0]);
    return digits ? `${digits}@s.whatsapp.net` : '';
  }
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

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === 'string' ? value.trim() : String(value).trim();
    if (text) return text;
  }
  return null;
}

function asObj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function propVal(obj, ...nomes) {
  if (!obj) return undefined;
  const wanted = new Set(nomes.map((n) => n.toLowerCase().replace(/_/g, '')));
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.has(k.toLowerCase().replace(/_/g, ''))) return v;
  }
  return undefined;
}

function propObj(root, ...nomes) {
  if (!root || typeof root !== 'object') return null;
  const wanted = new Set(nomes.map((n) => n.toLowerCase()));
  for (const [k, v] of Object.entries(root)) {
    if (wanted.has(k.toLowerCase())) {
      const obj = asObj(v);
      if (obj) return obj;
    }
  }
  return null;
}

function objetoContent(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        return asObj(parsed);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/** Id composto Uazapi tipo `5548…:3A…` — não é rótulo de botão. */
function pareceIdMensagemUazapi(s) {
  const t = String(s || '').trim();
  return /^\d{10,}:[0-9A-Fa-f]+$/.test(t) || /^[0-9A-Fa-f]{16,}$/.test(t);
}

/** Rótulo de botão WhatsApp (curto, 1 linha). */
function pareceRotuloBotao(s) {
  const t = String(s || '').trim();
  if (!t || pareceIdMensagemUazapi(t)) return false;
  if (t.includes('\n')) return false;
  if (t.length > 48) return false;
  return true;
}

function acharNativeFlow(...roots) {
  for (const root of roots) {
    if (!root) continue;
    const direct = propObj(
      root,
      'nativeFlowResponseMessage',
      'native_flow_response_message',
    );
    if (direct) return direct;

    const irm = propObj(
      root,
      'interactiveResponseMessage',
      'InteractiveResponseMessage',
      'interactive_response_message',
    );
    if (irm) {
      const nested = propObj(
        irm,
        'nativeFlowResponseMessage',
        'native_flow_response_message',
      );
      if (nested) return nested;
    }

    const content = objetoContent(root.content);
    if (content && content !== root) {
      const hit = acharNativeFlow(content);
      if (hit) return hit;
    }
  }
  return null;
}

function textoDoNativeFlow(nfr) {
  const raw = firstNonEmpty(
    nfr.paramsJson,
    nfr.params_json,
    nfr.responseJson,
    nfr.response_json,
    nfr.body,
  );
  let titulo = null;
  let id = null;
  if (raw?.startsWith('{')) {
    try {
      const p = JSON.parse(raw);
      titulo = firstNonEmpty(
        p.title,
        p.display_text,
        p.displayText,
        p.text,
        p.description,
      );
      id = firstNonEmpty(p.id, p.button_id, p.buttonId, p.rowId, p.selectedId);
    } catch {
      /* paramsJson não-JSON */
    }
  }
  if (!titulo) titulo = firstNonEmpty(nfr.title, nfr.name);
  if (!id) id = firstNonEmpty(nfr.id);
  return { titulo, id };
}

const TIPO_INTERATIVO_RE =
  /button|list.?response|interactive|template.?button|native.?flow|response.?message|buttons_response/i;

function pareceCliqueBotaoComoDocumento(contentObj, mediaType, typeFlat, temCitacao) {
  if (/^(image|imagem|video|audio|ptt|myaudio|sticker)(message)?$/i.test(mediaType || typeFlat)) {
    return false;
  }
  const mime = String(contentObj?.mimetype || mediaType || '').toLowerCase();
  if (/pdf|image\/|video\/|audio\/|ogg|mp4|jpeg|png|webp/.test(mime)) return false;
  const typeHint = `${mediaType} ${typeFlat}`;
  const pareceDoc =
    /document/i.test(typeHint) ||
    typeFlat === 'media' ||
    /octet-stream|application\/json/.test(mime) ||
    (temCitacao && !mime && typeFlat !== 'text');
  if (!pareceDoc) return false;
  const fileName = firstNonEmpty(contentObj?.fileName, contentObj?.filename);
  if (fileName && /\.[a-z0-9]{2,5}$/i.test(fileName)) return false;
  const len = Number(contentObj?.fileLength || contentObj?.filelength || 0);
  if (Number.isFinite(len) && len > 4096) return false;
  if (fileName) return fileName.length <= 48;
  return temCitacao || /octet-stream|application\/json/.test(mime);
}

/**
 * Detecta clique de botão/lista e extrai rótulo + id.
 * Normaliza para texto (nunca documento/mídia).
 */
export function extrairRespostaBotao(message = {}) {
  const contentObj = objetoContent(message.content);
  const mediaType = String(message.mediaType || '').toLowerCase();
  const typeFlat = String(message.type || '').toLowerCase();
  const messageType = String(message.messageType || '').toLowerCase();
  const tipoHint = `${mediaType} ${typeFlat} ${messageType}`;

  const nfr = acharNativeFlow(message, contentObj);
  const temCitacao = Boolean(
    message.quoted ||
      message.replyid ||
      message.replyId ||
      message.extendedTextMessage ||
      contentObj?.contextInfo,
  );

  const response = asObj(propVal(contentObj, 'Response', 'response'));
  const temCamposBotao = Boolean(
    nfr ||
      message.buttonsResponseMessage ||
      message.listResponseMessage ||
      message.templateButtonReplyMessage ||
      message.interactive ||
      contentObj?.selectedButtonId ||
      contentObj?.selectedButtonID ||
      contentObj?.selectedRowId ||
      contentObj?.selectedDisplayText ||
      response?.SelectedDisplayText ||
      response?.selectedDisplayText ||
      contentObj?.buttonOrRowId ||
      message.vote ||
      message.buttonOrListid ||
      message.buttonOrListId ||
      message.selectedButtonId ||
      message.selectedRowId ||
      message.buttonOrRowId,
  );

  const isInteractiveReply =
    temCamposBotao ||
    TIPO_INTERATIVO_RE.test(tipoHint) ||
    pareceCliqueBotaoComoDocumento(contentObj, mediaType, typeFlat, temCitacao);

  if (!isInteractiveReply) {
    // Citação do menu + extendedTextMessage.text curto
    const ext = asObj(message.extendedTextMessage)?.text;
    if (temCitacao && pareceRotuloBotao(ext)) {
      return {
        isButton: true,
        label: String(ext).trim(),
        id: null,
        quotedId: firstNonEmpty(message.quoted, message.replyid, message.replyId),
      };
    }
    return null;
  }

  // Prioridade do rótulo (docs HubLabel)
  const vote = firstNonEmpty(message.vote);
  const selectedDisplay = firstNonEmpty(
    response?.SelectedDisplayText,
    response?.selectedDisplayText,
    contentObj?.selectedDisplayText,
    contentObj?.SelectedDisplayText,
    contentObj?.selectedButtonText,
    message.selectedDisplayText,
  );
  const native = nfr ? textoDoNativeFlow(nfr) : { titulo: null, id: null };
  const fileName = firstNonEmpty(contentObj?.fileName, contentObj?.filename);
  const extText = firstNonEmpty(asObj(message.extendedTextMessage)?.text);

  let label = null;
  if (vote && pareceRotuloBotao(vote)) label = vote;
  else if (selectedDisplay && pareceRotuloBotao(selectedDisplay)) label = selectedDisplay;
  else if (native.titulo && pareceRotuloBotao(native.titulo)) label = native.titulo;
  else if (fileName && pareceRotuloBotao(fileName) && !/\.[a-z0-9]{2,5}$/i.test(fileName)) {
    label = fileName;
  } else if (extText && pareceRotuloBotao(extText)) label = extText;
  else if (typeof message.text === 'string' && pareceRotuloBotao(message.text)) {
    label = message.text.trim();
  }

  const id = firstNonEmpty(
    message.buttonOrListid,
    message.buttonOrListId,
    contentObj?.selectedButtonID,
    contentObj?.selectedButtonId,
    contentObj?.selectedRowId,
    contentObj?.buttonOrListid,
    contentObj?.buttonOrListId,
    message.selectedButtonId,
    message.selectedRowId,
    native.id,
  );

  if (!label && id) label = id;
  if (!label) return { isButton: true, label: null, id, quotedId: null };

  const quotedId = firstNonEmpty(
    message.quoted,
    message.replyid,
    message.replyId,
    contentObj?.contextInfo?.stanzaID,
    contentObj?.contextInfo?.stanzaId,
    asObj(contentObj?.contextInfo)?.stanzaID,
  );

  return {
    isButton: true,
    label: String(label).trim(),
    id: id ? String(id).trim() : null,
    quotedId: quotedId ? String(quotedId).trim() : null,
  };
}

/**
 * Telefone/JID do contato da conversa (não do remetente).
 * Preferência: message.chatid → chat.wa_chatid → chat.phone → message.phone
 */
function resolveContactJid(message = {}, chat = {}) {
  return (
    ensurePhoneJid(message.chatid) ||
    ensurePhoneJid(chat.wa_chatid) ||
    ensurePhoneJid(chat.phone) ||
    ensurePhoneJid(message.phone) ||
    ensureLidJid(message.sender_lid) ||
    ''
  );
}

function resolveContactName(message = {}, chat = {}) {
  return firstNonEmpty(
    chat.wa_contactName,
    chat.wa_name,
    chat.name,
    message.pushName,
    message.senderName,
    message.name,
  );
}

function resolveMediaUrl(message = {}) {
  const content = objetoContent(message.content) || {};
  return firstNonEmpty(
    message.fileURL,
    message.fileUrl,
    message.mediaUrl,
    content.URL,
    content.url,
  );
}

function resolveMessageText(message = {}) {
  const content = message.content;
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (typeof content === 'string' && content.trim()) return content;
  const contentObj = objetoContent(content);
  if (contentObj) {
    return firstNonEmpty(contentObj.caption, contentObj.text, contentObj.fileName, contentObj.title) || '';
  }
  return '';
}

function resolveArquivoNome(message = {}) {
  const content = objetoContent(message.content) || {};
  return firstNonEmpty(content.fileName, content.title, message.text);
}

/** Detecta payload UazAPI (formato EventType ou event=messages). */
export function isUazapiWebhookShape(body = {}) {
  if (!body || typeof body !== 'object') return false;
  if (body.EventType || body.message || body.chat) return true;
  const event = String(body.event || body.Event || '').toLowerCase();
  return event === 'messages' || event === 'messages_update' || event === 'connection';
}

export function organizeUazapiWebhook(body, conexao = {}) {
  const message = body?.message || body?.data?.message || body?.data || {};
  const chat = body?.chat || body?.data?.chat || {};

  // Contato da conversa — NÃO usar sender_pn (em fromMe=true é o owner)
  const remoteJid = resolveContactJid(message, chat);
  const lid = ensureLidJid(message.sender_lid || '');
  const fromMe = Boolean(message.fromMe);
  const contactName = resolveContactName(message, chat);
  const messageId = message.messageid || message.id || null;

  const botao = extrairRespostaBotao(message);

  let conversation = resolveMessageText(message);
  let messageType = mapUazapiMessageTypeToEvolution(message);
  let arquivoUrl = resolveMediaUrl(message);
  let arquivoNomeOriginal = resolveArquivoNome(message);
  let mensagemRespondida = message.quoted || message.replyid || null;
  let idInterativo = null;

  if (botao?.isButton) {
    // Clique → sempre texto; nunca documento/mídia
    messageType = 'conversation';
    conversation = botao.label || botao.id || conversation || '';
    idInterativo = botao.id;
    mensagemRespondida = botao.quotedId || mensagemRespondida;
    arquivoUrl = null;
    arquivoNomeOriginal = null;
  }

  return {
    remoteJid,
    lid,
    pushName: contactName,
    fromMe,
    messageId,
    conversation,
    messageType,
    arquivoNomeOriginal,
    source: message.source || 'uazapi',
    serverUrl: body.BaseUrl || conexao.urlApi || null,
    instance: conexao.instanceName || body.instanceName || body.instance || null,
    apikey: body.token || conexao.Apikey || null,
    mensagemRespondida,
    arquivoUrl,
    fotoUrl: firstNonEmpty(chat.imagePreview, chat.image, message.imagePreview),
    isGroup: Boolean(message.isGroup || chat.wa_isGroup),
    owner: body.owner || null,
    wasSentByApi: Boolean(message.wasSentByApi),
    idInterativo,
    isButtonReply: Boolean(botao?.isButton),
    provedorApi: 'uazapi',
  };
}

export function isAllowedUazapiChat(organized) {
  if (!organized?.remoteJid) return false;
  if (organized.isGroup) return false;
  if (organized.remoteJid.includes('@g.us')) return false;
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
      arquivoNomeOriginal: organized.arquivoNomeOriginal || null,
      mensagemRespondida: organized.mensagemRespondida,
    },
    evolu: {
      server_url: organized.serverUrl,
      instance: organized.instance,
      apikey: organized.apikey,
    },
  };
}
