import { getEvolutionConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isUazapiConexao, resolveProvedorApi } from '../../provedorApi.js';
import {
  fetchConexaoByContaAndInstance,
  updateConexaoByInstanceName,
} from '../../supabase.js';
import { createUazapiClient } from '../../uazapi/client.js';
import { HttpError } from '../meta/httpError.js';

function textoObrigatorio(value, campo) {
  const texto = String(value ?? '').trim();
  if (!texto) throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  return texto;
}

function normalizeTelefoneFromOwner(owner) {
  return String(owner || '')
    .replace(/@.+$/, '')
    .replace(/\D/g, '');
}

async function fetchEvolutionProfile({ instanceName, apikey, inboundConfig }) {
  const config = getEvolutionConfig();
  const baseUrl = String(
    inboundConfig?.evolutionBaseUrl || config.evolutionBaseUrl || '',
  ).replace(/\/+$/, '');

  const res = await fetch(`${baseUrl}/instance/fetchInstances`, {
    method: 'GET',
    headers: { apikey: apikey || config.evolutionApiKey },
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(
      json?.message || `Evolution fetchInstances HTTP ${res.status}`,
      502,
    );
  }

  const list = Array.isArray(json) ? json : json?.instance ? [json] : [];
  const match =
    list.find((row) => {
      const name =
        row?.instance?.instanceName ||
        row?.instanceName ||
        row?.name ||
        row?.instance?.name;
      return String(name) === String(instanceName);
    }) || list[0];

  if (!match) throw new HttpError('Instancia Evolution nao encontrada.', 404);

  const profilePicUrl =
    match.profilePicUrl ||
    match.instance?.profilePicUrl ||
    match.profilePictureUrl ||
    null;
  const ownerJid =
    match.ownerJid ||
    match.owner ||
    match.instance?.ownerJid ||
    match.instance?.owner ||
    null;

  return {
    FotoPerfil: profilePicUrl,
    Telefone: normalizeTelefoneFromOwner(ownerJid),
  };
}

async function fetchUazapiProfile(conexao) {
  const baseUrl = String(conexao.urlApi || '').replace(/\/+$/, '');
  if (!baseUrl || !conexao.Apikey) {
    throw new HttpError('Conexao UazAPI incompleta (urlApi/Apikey).', 400);
  }

  const client = createUazapiClient({
    baseUrl,
    instanceToken: conexao.Apikey,
  });
  const status = await client.getStatus();
  const instance = status?.instance || status || {};

  return {
    FotoPerfil: instance.profilePicUrl || instance.profilePictureUrl || null,
    Telefone: normalizeTelefoneFromOwner(instance.owner || instance.ownerJid),
  };
}

/** Equivalente ao fluxo n8n `salvarfoto`. */
export async function salvarFotoETelefoneConexao(body, inboundConfig) {
  const contaId = textoObrigatorio(body.contaId, 'contaId');
  const instanceName = textoObrigatorio(body.instanceName, 'instanceName');

  logger.info('[salvar-foto] inicio', { contaId, instanceName });

  const conexao = await fetchConexaoByContaAndInstance(contaId, instanceName);
  if (!conexao) throw new HttpError('Conexao nao encontrada.', 404);

  const provedor = resolveProvedorApi(conexao);
  logger.info('[salvar-foto] buscando perfil', {
    conexaoId: conexao.id,
    provedor,
    instanceName,
  });

  let profile;
  try {
    profile = isUazapiConexao(conexao)
      ? await fetchUazapiProfile(conexao)
      : await fetchEvolutionProfile({
          instanceName,
          apikey: conexao.Apikey,
          inboundConfig,
        });
  } catch (error) {
    logger.error('[salvar-foto] falha ao buscar perfil', {
      conexaoId: conexao.id,
      provedor,
      instanceName,
      message: error instanceof Error ? error.message : String(error),
      status: error?.status || error?.statusCode || null,
      body: error?.body ?? null,
    });
    throw error;
  }

  await updateConexaoByInstanceName(instanceName, {
    ...(profile.FotoPerfil ? { FotoPerfil: profile.FotoPerfil } : {}),
    ...(profile.Telefone ? { Telefone: profile.Telefone } : {}),
  });

  logger.info('[salvar-foto] ok', {
    conexaoId: conexao.id,
    provedor,
    instanceName,
    telefone: profile.Telefone || null,
    hasFoto: Boolean(profile.FotoPerfil),
  });

  return { resposta: 'Foto salva com sucesso!', ...profile };
}
