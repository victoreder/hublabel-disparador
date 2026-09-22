import { getEvolutionConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { resolveProvedorApi } from '../../provedorApi.js';
import {
  fetchConexaoById,
  fetchConexaoByInstanceName,
  updateGrupoParticipantesCount,
} from '../../supabase.js';
import { createUazapiClient } from '../../uazapi/client.js';
import { HttpError } from '../meta/httpError.js';

function textoObrigatorio(value, campo) {
  const texto = String(value ?? '').trim();
  if (!texto) throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  return texto;
}

function inteiroObrigatorio(value, campo) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  return n;
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.groups)) return payload.groups;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.participants)) return payload.participants;
  return [];
}

function payloadShape(payload) {
  if (Array.isArray(payload)) return 'array';
  if (payload == null) return 'null';
  if (typeof payload !== 'object') return typeof payload;
  if (Array.isArray(payload.contacts)) return 'contacts';
  if (Array.isArray(payload.data)) return 'data';
  return 'object';
}

function apiHost(url) {
  try {
    return new URL(String(url || '')).host;
  } catch {
    return null;
  }
}

async function resolveConexao(body) {
  if (body.idConexao != null && body.idConexao !== '') {
    const id = inteiroObrigatorio(body.idConexao, 'idConexao');
    const conexao = await fetchConexaoById(id);
    if (!conexao) throw new HttpError('Conexao nao encontrada.', 404);
    return conexao;
  }

  const instanceName = textoObrigatorio(body.instanceName, 'instanceName');
  const conexao = await fetchConexaoByInstanceName(instanceName);
  if (!conexao) throw new HttpError('Conexao nao encontrada para instanceName.', 404);
  return conexao;
}

function evolutionAuth(conexao, inboundConfig) {
  const config = getEvolutionConfig();
  const baseUrl = String(
    conexao.urlApi || inboundConfig?.evolutionBaseUrl || config.evolutionBaseUrl || '',
  ).replace(/\/+$/, '');
  const apikey = conexao.Apikey || config.evolutionApiKey;
  const instanceName = conexao.instanceName;
  if (!baseUrl || !apikey || !instanceName) {
    throw new HttpError('Conexao Evolution incompleta.', 400);
  }
  return { baseUrl, apikey, instanceName };
}

function uazapiClient(conexao) {
  const baseUrl = String(conexao.urlApi || '').replace(/\/+$/, '');
  if (!baseUrl || !conexao.Apikey) {
    throw new HttpError('Conexao UazAPI incompleta (urlApi/Apikey).', 400);
  }
  return createUazapiClient({ baseUrl, instanceToken: conexao.Apikey });
}

async function evolutionGet(path, { baseUrl, apikey }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { apikey },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(
      json?.message || json?.error || `Evolution HTTP ${res.status}`,
      502,
    );
  }
  return json;
}

async function evolutionPost(path, { baseUrl, apikey }, body = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      apikey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(
      json?.message || json?.error || `Evolution HTTP ${res.status}`,
      502,
    );
  }
  return json;
}

function mapGrupoListItem(row) {
  return {
    id: row.id || row.jid || row.groupJid || row.groupjid || null,
    subject: row.subject || row.Name || row.name || row.subjectOwner || null,
    owner: row.owner || row.Owner || null,
    announce: row.announce ?? row.IsAnnounce ?? row.isAnnounce ?? null,
    isCommunity: row.isCommunity ?? row.IsCommunity ?? null,
  };
}

function extractParticipants(payload) {
  if (Array.isArray(payload?.participants)) return payload.participants;
  if (Array.isArray(payload?.Participants)) return payload.Participants;
  if (Array.isArray(payload?.data?.participants)) return payload.data.participants;
  if (Array.isArray(payload)) return payload;
  return [];
}

/** acao: puxarGruposWpp | listarGrupos */
export async function listarGruposWhatsApp(body, inboundConfig) {
  const conexao = await resolveConexao(body);
  const provedor = resolveProvedorApi(conexao);

  logger.info('[listar-grupos] inicio', {
    idConexao: conexao.id,
    provedor,
    instanceName: conexao.instanceName,
  });

  let raw;
  if (provedor === 'uazapi') {
    raw = await uazapiClient(conexao).listGroups();
  } else {
    const auth = evolutionAuth(conexao, inboundConfig);
    raw = await evolutionGet(
      `/group/fetchAllGroups/${encodeURIComponent(auth.instanceName)}?getParticipants=false`,
      auth,
    );
  }

  const grupos = asArray(raw).map(mapGrupoListItem).filter((g) => g.id);

  logger.info('[listar-grupos] ok', {
    idConexao: conexao.id,
    provedor,
    total: grupos.length,
  });

  return { ok: true, provedorApi: provedor, total: grupos.length, data: grupos };
}

async function fetchParticipants(conexao, whatsAppId, inboundConfig) {
  const provedor = resolveProvedorApi(conexao);
  if (provedor === 'uazapi') {
    const info = await uazapiClient(conexao).getGroupInfo(whatsAppId);
    return {
      provedor,
      participants: extractParticipants(info),
      raw: info,
    };
  }

  const auth = evolutionAuth(conexao, inboundConfig);
  const raw = await evolutionGet(
    `/group/participants/${encodeURIComponent(auth.instanceName)}?groupJid=${encodeURIComponent(whatsAppId)}`,
    auth,
  );
  return {
    provedor,
    participants: extractParticipants(raw),
    raw,
  };
}

/** acao: contarParticipantes */
export async function contarParticipantesGrupo(body, inboundConfig) {
  const conexao = await resolveConexao(body);
  const whatsAppId = textoObrigatorio(body.WhatsAppId ?? body.whatsAppId, 'WhatsAppId');

  logger.info('[contar-participantes] inicio', {
    idConexao: conexao.id,
    whatsAppId,
    provedor: resolveProvedorApi(conexao),
  });

  const { provedor, participants } = await fetchParticipants(
    conexao,
    whatsAppId,
    inboundConfig,
  );
  const participantes = participants.length;

  const saved = await updateGrupoParticipantesCount(whatsAppId, participantes);

  logger.info('[contar-participantes] ok', {
    idConexao: conexao.id,
    provedor,
    whatsAppId,
    participantes,
    saved,
  });

  return {
    ok: true,
    provedorApi: provedor,
    WhatsAppId: whatsAppId,
    participantes,
    saved,
  };
}

/** acao: exportarParticipantes */
export async function exportarParticipantesGrupo(body, inboundConfig) {
  const conexao = await resolveConexao(body);
  const whatsAppId = textoObrigatorio(body.WhatsAppId ?? body.whatsAppId, 'WhatsAppId');

  logger.info('[exportar-participantes] inicio', {
    idConexao: conexao.id,
    whatsAppId,
    provedor: resolveProvedorApi(conexao),
  });

  const { provedor, participants, raw } = await fetchParticipants(
    conexao,
    whatsAppId,
    inboundConfig,
  );

  logger.info('[exportar-participantes] ok', {
    idConexao: conexao.id,
    provedor,
    whatsAppId,
    total: participants.length,
  });

  return {
    ok: true,
    provedorApi: provedor,
    WhatsAppId: whatsAppId,
    total: participants.length,
    participants,
    raw,
  };
}

/** acao: puxarContatosWpp — retorna contatos brutos (sem upsert no banco). */
export async function puxarContatosWpp(body, inboundConfig) {
  const startedAt = Date.now();
  const resolveStartedAt = Date.now();
  logger.info('[puxar-contatos-wpp] requisicao recebida', {
    idConexao: body.idConexao ?? null,
    instanceName: body.instanceName ?? null,
  });

  const conexao = await resolveConexao(body);
  const resolveDurationMs = Date.now() - resolveStartedAt;
  const provedor = resolveProvedorApi(conexao);

  logger.info('[puxar-contatos-wpp] conexao localizada', {
    idConexao: conexao.id,
    provedor,
    instanceName: conexao.instanceName,
    resolveDurationMs,
  });

  let chats;
  let providerDurationMs;
  if (provedor === 'uazapi') {
    const providerStartedAt = Date.now();
    logger.info('[puxar-contatos-wpp] consultando UazAPI', {
      idConexao: conexao.id,
      method: 'GET',
      endpoint: '/contacts',
      apiHost: apiHost(conexao.urlApi),
    });

    let contatos;
    try {
      contatos = await uazapiClient(conexao).listContacts();
      providerDurationMs = Date.now() - providerStartedAt;
    } catch (error) {
      providerDurationMs = Date.now() - providerStartedAt;
      logger.error('[puxar-contatos-wpp] UazAPI falhou', {
        idConexao: conexao.id,
        endpoint: '/contacts',
        providerDurationMs,
        upstreamStatus: error?.status ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    chats = Array.isArray(contatos)
      ? contatos
      : Array.isArray(contatos?.contacts)
        ? contatos.contacts
        : asArray(contatos);

    logger.info('[puxar-contatos-wpp] UazAPI respondeu', {
      idConexao: conexao.id,
      endpoint: '/contacts',
      providerDurationMs,
      payloadShape: payloadShape(contatos),
      total: chats.length,
    });
  } else {
    const providerStartedAt = Date.now();
    const auth = evolutionAuth(conexao, inboundConfig);
    const json = await evolutionPost(
      `/chat/findChats/${encodeURIComponent(auth.instanceName)}`,
      auth,
      {},
    );
    providerDurationMs = Date.now() - providerStartedAt;
    chats = asArray(json);
  }

  const logResult = {
    idConexao: conexao.id,
    provedor,
    total: chats.length,
    resolveDurationMs,
    providerDurationMs,
    durationMs: Date.now() - startedAt,
  };
  if (chats.length === 0) {
    logger.warn('[puxar-contatos-wpp] concluido sem contatos', logResult);
  } else {
    logger.info('[puxar-contatos-wpp] concluido', logResult);
  }

  return {
    ok: true,
    provedorApi: provedor,
    total: chats.length,
    data: chats,
  };
}
