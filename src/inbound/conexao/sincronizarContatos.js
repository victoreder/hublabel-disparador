import { getEvolutionConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { resolveProvedorApi } from '../../provedorApi.js';
import {
  fetchConexaoById,
  upsertConversasAgentes,
} from '../../supabase.js';
import { createUazapiClient } from '../../uazapi/client.js';
import { HttpError } from '../meta/httpError.js';

function textoObrigatorio(value, campo) {
  const texto = String(value ?? '').trim();
  if (!texto) throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  return texto;
}

function inteiroObrigatorio(value, campo) {
  const numero = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  }
  return numero;
}

function hasWhatsAppJid(value) {
  return String(value || '').includes('@s.whatsapp.net') && String(value || '').trim() !== '';
}

function isGroupJid(value) {
  const v = String(value || '');
  return v.includes('@g.us') || v.includes('@broadcast');
}

/** Prioridade igual ao n8n: qualquer JID com @s.whatsapp.net. */
function pickEvolutionTelefone(chat) {
  const a = String(chat?.remoteJid || '');
  const b = String(chat?.remoteJidAlt || '');
  const c = String(chat?.lastMessage?.key?.remoteJid || '');
  const d = String(chat?.lastMessage?.key?.remoteJidAlt || '');

  if (hasWhatsAppJid(a)) return a;
  if (hasWhatsAppJid(b)) return b;
  if (hasWhatsAppJid(c)) return c;
  if (hasWhatsAppJid(d)) return d;
  return a || b || c || d || null;
}

function normalizePhoneJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function asChatArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.chats)) return payload.chats;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

async function fetchEvolutionChats({ instanceName, apikey, inboundConfig }) {
  const config = getEvolutionConfig();
  const baseUrl = String(
    inboundConfig?.evolutionBaseUrl || config.evolutionBaseUrl || '',
  ).replace(/\/+$/, '');
  const key = apikey || config.evolutionApiKey;

  const res = await fetch(
    `${baseUrl}/chat/findChats/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: {
        apikey: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(
      json?.message || json?.error || `Evolution findChats HTTP ${res.status}`,
      502,
    );
  }

  return asChatArray(json);
}

async function fetchUazapiChats(conexao) {
  const baseUrl = String(conexao.urlApi || '').replace(/\/+$/, '');
  if (!baseUrl || !conexao.Apikey) {
    throw new HttpError('Conexao UazAPI incompleta (urlApi/Apikey).', 400);
  }

  const client = createUazapiClient({
    baseUrl,
    instanceToken: conexao.Apikey,
  });
  const json = await client.listChats();
  return asChatArray(json);
}

function mapEvolutionChat(chat, { idConexao, userId }) {
  const telefone = pickEvolutionTelefone(chat);
  if (!telefone || isGroupJid(telefone) || isGroupJid(chat?.remoteJid)) {
    return null;
  }

  return {
    telefone,
    nomeConversa: chat?.pushName || chat?.name || null,
    statusAtendimento: 'aguardando',
    idConexao,
    pausado: false,
    userId,
    lida: true,
    fotoPerfil: chat?.profilePicUrl || chat?.profilePictureUrl || null,
  };
}

function mapUazapiChat(chat, { idConexao, userId }) {
  const isGroup =
    Boolean(chat?.wa_isGroup) ||
    Boolean(chat?.isGroup) ||
    isGroupJid(chat?.wa_chatid) ||
    isGroupJid(chat?.id) ||
    isGroupJid(chat?.phone);

  if (isGroup) return null;

  const telefone = normalizePhoneJid(
    chat?.phone || chat?.wa_chatid || chat?.id || chat?.wa_fastid,
  );
  if (!telefone || isGroupJid(telefone)) return null;

  return {
    telefone,
    nomeConversa:
      chat?.wa_contactName ||
      chat?.wa_name ||
      chat?.name ||
      chat?.lead_name ||
      null,
    statusAtendimento: 'aguardando',
    idConexao,
    pausado: false,
    userId,
    lida: true,
    fotoPerfil: chat?.image || chat?.imagePreview || chat?.profilePicUrl || null,
  };
}

/**
 * Equivalente ao fluxo n8n `sincronizar-contatos`.
 * Body: { acao, idConexao, userId, instanceName? }
 */
export async function sincronizarContatosWhatsApp(body, inboundConfig) {
  const idConexao = inteiroObrigatorio(body.idConexao, 'idConexao');
  const userId = textoObrigatorio(body.userId, 'userId');

  logger.info('[sync-contatos] inicio', {
    idConexao,
    userId,
    instanceNameBody: body.instanceName || null,
  });

  const conexao = await fetchConexaoById(idConexao);
  if (!conexao) throw new HttpError('Conexao nao encontrada.', 404);
  if (conexao.apiOficial) {
    throw new HttpError('Sincronizar contatos nao suportado para API Oficial.', 400);
  }

  const instanceName = String(body.instanceName || conexao.instanceName || '').trim();
  if (!instanceName) throw new HttpError('instanceName obrigatorio.', 400);

  const provedor = resolveProvedorApi(conexao);
  logger.info('[sync-contatos] buscando chats', {
    idConexao,
    provedor,
    instanceName,
  });

  let chats;
  try {
    chats =
      provedor === 'uazapi'
        ? await fetchUazapiChats(conexao)
        : await fetchEvolutionChats({
            instanceName,
            apikey: conexao.Apikey,
            inboundConfig,
          });
  } catch (error) {
    logger.error('[sync-contatos] falha ao buscar chats', {
      idConexao,
      provedor,
      instanceName,
      message: error instanceof Error ? error.message : String(error),
      status: error?.status || error?.statusCode || null,
      body: error?.body ?? null,
    });
    throw error;
  }

  const ctx = { idConexao, userId };
  const items = [];
  let skippedGroups = 0;

  for (const chat of chats) {
    const mapped =
      provedor === 'uazapi'
        ? mapUazapiChat(chat, ctx)
        : mapEvolutionChat(chat, ctx);

    if (!mapped) {
      skippedGroups += 1;
      continue;
    }
    items.push(mapped);
  }

  logger.info('[sync-contatos] chats mapeados', {
    idConexao,
    provedor,
    totalChats: chats.length,
    individuais: items.length,
    skippedGroups,
  });

  if (!items.length) {
    return {
      ok: true,
      provedorApi: provedor,
      totalChats: chats.length,
      individuais: 0,
      skippedGroups,
      resultado: { inserted: 0, skipped: 0 },
    };
  }

  const resultado = await upsertConversasAgentes(items);

  logger.info('[sync-contatos] ok', {
    idConexao,
    provedor,
    individuais: items.length,
    resultado,
  });

  return {
    ok: true,
    provedorApi: provedor,
    totalChats: chats.length,
    individuais: items.length,
    skippedGroups,
    resultado,
  };
}
