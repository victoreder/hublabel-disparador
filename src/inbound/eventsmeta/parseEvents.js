const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker']);

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

/** Extrai eventos do payload bruto da Meta (igual nó EXTRAIR EVENTOS). */
export function parseMetaWebhookBody(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const events = [];

  for (const entry of entries) {
    const wabaId = entry.id;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      events.push({
        waba_id: wabaId,
        field: change.field,
        value: change.value,
        received_at: new Date().toISOString(),
      });
    }
  }

  return events;
}

function resolveEchoTelefone(msg) {
  return (
    msg?.to ||
    msg?.to_user_id ||
    msg?.to_parent_user_id ||
    null
  );
}

function buildMediaJobFromMessage({
  event,
  value,
  msg,
  telefone,
  nomeContato,
  fromMe = false,
}) {
  const type = msg.type;
  if (!MEDIA_TYPES.has(type)) return null;

  const block = msg[type] || {};
  const mediaId = block.id;
  if (!mediaId) return null;

  let ext = EXT_BY_MIME[(block.mime_type || '').toLowerCase()] || 'bin';
  if (block.filename && String(block.filename).includes('.')) {
    ext = String(block.filename).split('.').pop() || ext;
  }

  const safeId = String(msg.id || mediaId).replace(/[^a-zA-Z0-9._-]/g, '_');

  return {
    waba_id: event.waba_id,
    phone_number_id: value.metadata?.phone_number_id || null,
    meta_message_id: msg.id,
    telefone,
    tipo_mensagem: type,
    mensagem: block.caption || null,
    media_id: mediaId,
    mime_type: block.mime_type || null,
    filename_meta: block.filename || null,
    nome_contato: nomeContato,
    received_at: event.received_at,
    file_ext: ext,
    safe_message_id: safeId,
    mensagemRespondida: msg.context?.id || null,
    from_me: fromMe,
  };
}

/** Extrai jobs de mídia de eventos field=messages e smb_message_echoes. */
export function extractMediaJobs(events) {
  const jobs = [];

  for (const event of events) {
    const value = event.value || {};
    const phoneNumberId = value.metadata?.phone_number_id || null;

    if (event.field === 'messages') {
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const nomeContato = contacts[0]?.profile?.name || null;
      const messages = Array.isArray(value.messages) ? value.messages : [];

      for (const msg of messages) {
        const job = buildMediaJobFromMessage({
          event,
          value,
          msg,
          telefone: msg.from,
          nomeContato,
          fromMe: false,
        });
        if (job) jobs.push(job);
      }
      continue;
    }

    if (event.field === 'smb_message_echoes') {
      const echoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];

      for (const msg of echoes) {
        const telefone = resolveEchoTelefone(msg);
        if (!telefone) continue;

        const job = buildMediaJobFromMessage({
          event,
          value,
          msg,
          telefone,
          nomeContato: null,
          fromMe: true,
        });
        if (job) jobs.push(job);
      }
    }
  }

  return jobs;
}
