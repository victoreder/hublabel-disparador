import { logger } from '../../logger.js';
import {
  atualizarContatoFotoPerfil,
  fetchContatoFotoPerfil,
  fetchEvolutionConexaoDaConta,
} from '../../supabase.js';
import { createS3Client, uploadBuffer } from '../storage/s3.js';

const FETCH_TIMEOUT_MS = 12_000;

function normalizeTelefone(telefone) {
  return String(telefone || '').replace(/@.+$/, '').trim();
}

function fotoJaNoS3(url, s3PublicBaseUrl) {
  const base = String(s3PublicBaseUrl || '').replace(/\/$/, '');
  const atual = String(url || '').trim();
  return Boolean(base && atual.startsWith(`${base}/`));
}

export async function isUrlImagemAcessivel(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return false;

  try {
    const head = await fetch(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (head.ok) {
      const type = head.headers.get('content-type') || '';
      if (type.startsWith('image/')) return true;
      if (!type || type === 'application/octet-stream') return true;
    }
  } catch {
    // fallback GET abaixo
  }

  try {
    const get = await fetch(target, {
      method: 'GET',
      headers: { Range: 'bytes=0-511' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!get.ok) return false;
    const type = get.headers.get('content-type') || '';
    return type.startsWith('image/') || type === 'application/octet-stream' || !type;
  } catch {
    return false;
  }
}

export async function precisaAtualizarFotoPerfil({ fotoPerfil, contatoCriado, s3PublicBaseUrl }) {
  if (contatoCriado) return true;

  const url = String(fotoPerfil || '').trim();
  if (!url) return true;

  if (fotoJaNoS3(url, s3PublicBaseUrl)) {
    return !(await isUrlImagemAcessivel(url));
  }

  return !(await isUrlImagemAcessivel(url));
}

export async function fetchEvolutionProfilePictureUrl({ serverUrl, instance, apikey, telefone }) {
  const number = normalizeTelefone(telefone);
  if (!serverUrl || !instance || !apikey || !number) return null;

  const url = `${String(serverUrl).replace(/\/+$/, '')}/chat/fetchProfilePictureUrl/${instance}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ number }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) return null;

  return String(json?.profilePictureUrl || '').trim() || null;
}

async function resolveEvolutionCredentials({ evolution, conexao, contaId }) {
  if (evolution?.server_url && evolution?.instance && evolution?.apikey) {
    return {
      serverUrl: evolution.server_url,
      instance: evolution.instance,
      apikey: evolution.apikey,
    };
  }

  const baseUrl = process.env.EVOLUTION_BASE_URL?.trim()?.replace(/\/+$/, '');
  const globalKey = process.env.EVOLUTION_API_KEY?.trim();

  if (conexao?.instanceName && conexao?.Apikey && baseUrl) {
    return {
      serverUrl: baseUrl,
      instance: conexao.instanceName,
      apikey: conexao.Apikey,
    };
  }

  if (conexao?.instanceName && globalKey && baseUrl) {
    return {
      serverUrl: baseUrl,
      instance: conexao.instanceName,
      apikey: globalKey,
    };
  }

  if (!contaId) return null;

  const sibling = await fetchEvolutionConexaoDaConta(contaId);
  if (!sibling?.instanceName || !baseUrl) return null;

  return {
    serverUrl: baseUrl,
    instance: sibling.instanceName,
    apikey: sibling.Apikey || globalKey || null,
  };
}

async function downloadImage(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar imagem (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 64) {
    throw new Error('Imagem de perfil inválida ou vazia');
  }

  return { buffer, contentType };
}

function extFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

async function uploadFotoPerfilToS3({ buffer, contentType, s3Config, canal, contatoId, conexaoId }) {
  const ext = extFromContentType(contentType);
  const key = `contatos/${canal}/${conexaoId || 'sem-conexao'}/${contatoId}.${ext}`;
  const client = createS3Client(s3Config);

  await uploadBuffer({
    client,
    bucket: s3Config.bucket,
    key,
    body: buffer,
    contentType: contentType.startsWith('image/') ? contentType : 'image/jpeg',
  });

  return `${s3Config.publicBaseUrl}/${key}`;
}

export async function syncContatoFotoPerfil({
  contatoId,
  contatoCriado = false,
  telefone,
  fromMe = false,
  canal,
  conexaoId,
  contaId,
  conexao,
  evolution,
  s3Config,
}) {
  if (!contatoId || !telefone || fromMe || !s3Config) return null;

  const fotoAtual = await fetchContatoFotoPerfil(contatoId);
  const deveAtualizar = await precisaAtualizarFotoPerfil({
    fotoPerfil: fotoAtual,
    contatoCriado,
    s3PublicBaseUrl: s3Config.publicBaseUrl,
  });

  if (!deveAtualizar) return fotoAtual;

  let sourceUrl = null;

  // API Oficial Meta: Cloud API não expõe foto de perfil do contato (só do business profile).
  // Não tenta Evolution nesse canal.
  if (String(canal || '').toLowerCase() === 'meta') {
    if (fotoAtual && (await isUrlImagemAcessivel(fotoAtual))) {
      return fotoAtual;
    }
    logger.info('fotoPerfil: Meta Cloud API não fornece foto do contato', {
      contatoId,
      canal,
      conexaoId,
    });
    return null;
  }

  const evoCreds = await resolveEvolutionCredentials({ evolution, conexao, contaId });

  if (evoCreds?.apikey) {
    sourceUrl = await fetchEvolutionProfilePictureUrl({
      ...evoCreds,
      telefone,
    });
  }

  if (!sourceUrl && fotoAtual && (await isUrlImagemAcessivel(fotoAtual))) {
    sourceUrl = fotoAtual;
  }

  if (!sourceUrl) {
    logger.info('fotoPerfil: sem URL de origem', { contatoId, canal, conexaoId });
    return null;
  }

  const { buffer, contentType } = await downloadImage(sourceUrl);
  const publicUrl = await uploadFotoPerfilToS3({
    buffer,
    contentType,
    s3Config,
    canal,
    contatoId,
    conexaoId,
  });

  await atualizarContatoFotoPerfil(contatoId, publicUrl);

  logger.info('fotoPerfil salva no S3', { contatoId, canal, conexaoId, publicUrl });
  return publicUrl;
}

export function scheduleContatoFotoPerfilSync(params) {
  syncContatoFotoPerfil(params).catch((error) => {
    logger.warn('fotoPerfil sync falhou', {
      contatoId: params?.contatoId,
      canal: params?.canal,
      message: error.message,
    });
  });
}
