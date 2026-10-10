import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { logger } from './logger.js';

/*
 * Licenciamento da imagem vendida.
 *
 * A chave pública e a URL do servidor de licenças são embutidas no build (scripts/build.mjs,
 * via esbuild --define). Rodando direto do código-fonte (npm start / testes) elas não existem
 * e a verificação é desligada — o fonte fica só no repositório privado.
 *
 * A licença fica presa à instalação do cliente: fingerprint = hash do host do SUPABASE_URL.
 * O sistema inteiro depende desse banco, então a mesma licença não serve para outra instalação.
 */

/* global __HUBLABEL_LICENSE_PUBKEY__, __HUBLABEL_LICENSE_SERVER__, __HUBLABEL_VERSION__ */
const EMBEDDED_PUBKEY = typeof __HUBLABEL_LICENSE_PUBKEY__ === 'string' ? __HUBLABEL_LICENSE_PUBKEY__ : '';
const EMBEDDED_SERVER = typeof __HUBLABEL_LICENSE_SERVER__ === 'string' ? __HUBLABEL_LICENSE_SERVER__ : '';
const VERSION = typeof __HUBLABEL_VERSION__ === 'string' ? __HUBLABEL_VERSION__ : 'dev';

const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
const STARTUP_RETRY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_PATH = '/tmp/.hublabel-licenca.json';

export class LicenseRejectedError extends Error {
  constructor(motivo) {
    super(`Licença recusada: ${motivo}`);
    this.name = 'LicenseRejectedError';
    this.motivo = motivo;
  }
}

export function isLicenseEnforced() {
  return Boolean(EMBEDDED_PUBKEY && EMBEDDED_SERVER);
}

/** Host normalizado do Supabase do cliente (ex.: abcd.supabase.co). */
export function normalizeInstallationHost(supabaseUrl) {
  const raw = String(supabaseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export function computeFingerprint(supabaseUrl) {
  const host = normalizeInstallationHost(supabaseUrl);
  return createHash('sha256').update(`hublabel:${host}`).digest('hex');
}

/**
 * Confere a resposta assinada do servidor de licenças.
 * Retorna o payload decodificado ou lança erro se a assinatura/conteúdo não bater.
 */
export function verifySignedLicense(response, { publicKeyPem, fingerprint, nonce, now = Date.now() }) {
  if (!response?.payload || !response?.assinatura) {
    throw new Error('Resposta do servidor de licenças sem assinatura');
  }
  const data = Buffer.from(response.payload, 'base64');
  const signature = Buffer.from(response.assinatura, 'base64');
  const key = createPublicKey(publicKeyPem);
  if (!verify(null, data, key, signature)) {
    throw new Error('Assinatura da licença inválida');
  }

  const payload = JSON.parse(data.toString('utf8'));
  if (payload.fingerprint !== fingerprint) {
    throw new Error('Licença emitida para outra instalação');
  }
  if (nonce != null && payload.nonce !== nonce) {
    throw new Error('Resposta de licença reaproveitada (nonce diferente)');
  }
  if (payload.ok && Date.parse(payload.validoAte) < now) {
    throw new Error('Licença expirada (sem contato com o servidor de licenças)');
  }
  return payload;
}

function readLicenseEnv() {
  const email = process.env.LICENCA_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new LicenseRejectedError('defina LICENCA_EMAIL (e-mail da compra) nas variáveis de ambiente da stack');
  }
  return { email };
}

function readCache(fingerprint) {
  try {
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    const payload = verifySignedLicense(cached, { publicKeyPem: EMBEDDED_PUBKEY, fingerprint, nonce: null });
    return payload.ok ? payload : null;
  } catch {
    return null;
  }
}

function writeCache(response) {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(response), { mode: 0o600 });
  } catch {
    // Cache é só para reinício sem internet; falhar aqui não impede o uso.
  }
}

async function requestValidation(service) {
  const { email } = readLicenseEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const fingerprint = computeFingerprint(supabaseUrl);
  const nonce = randomBytes(16).toString('hex');

  let response;
  try {
    const res = await fetch(`${EMBEDDED_SERVER.replace(/\/+$/, '')}/v1/validar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        fingerprint,
        nonce,
        servico: service,
        versao: VERSION,
        instalacao: normalizeInstallationHost(supabaseUrl),
        hostname: hostname(),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    response = await res.json();
  } catch (error) {
    return { networkError: error, fingerprint };
  }

  const payload = verifySignedLicense(response, { publicKeyPem: EMBEDDED_PUBKEY, fingerprint, nonce });
  if (!payload.ok) throw new LicenseRejectedError(payload.motivo || 'licença inválida');
  writeCache(response);
  return { payload, fingerprint };
}

let lastValidUntil = 0;

/**
 * Bloqueia o startup até a licença ser validada. Chamado no início de cada entrypoint.
 * - Licença recusada (inválida, revogada, outra instalação): encerra o processo.
 * - Servidor de licenças fora do ar: usa a última validação assinada (cache) ou tenta de novo.
 */
export async function ensureLicense(service) {
  if (!isLicenseEnforced()) return;

  for (;;) {
    try {
      const result = await requestValidation(service);
      if (result.payload) {
        lastValidUntil = Date.parse(result.payload.validoAte);
        logger.info('Licença validada', { cliente: result.payload.cliente, servico: service });
        break;
      }

      const cached = readCache(result.fingerprint);
      if (cached) {
        lastValidUntil = Date.parse(cached.validoAte);
        logger.warn('Servidor de licenças indisponível — usando última validação', { validoAte: cached.validoAte });
        break;
      }
      logger.warn('Servidor de licenças indisponível — nova tentativa em 30s', {
        message: result.networkError?.message,
      });
    } catch (error) {
      logger.error(error instanceof LicenseRejectedError ? error.message : `Falha na licença: ${error.message}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_RETRY_MS));
  }

  setInterval(() => heartbeat(service), HEARTBEAT_MS).unref();
}

async function heartbeat(service) {
  try {
    const result = await requestValidation(service);
    if (result.payload) {
      lastValidUntil = Date.parse(result.payload.validoAte);
      return;
    }
    if (Date.now() > lastValidUntil) {
      logger.error('Licença expirada: sem contato com o servidor de licenças além da tolerância');
      process.exit(1);
    }
    logger.warn('Servidor de licenças indisponível — operando na tolerância', {
      validoAte: new Date(lastValidUntil).toISOString(),
    });
  } catch (error) {
    logger.error(error instanceof LicenseRejectedError ? error.message : `Falha na licença: ${error.message}`);
    process.exit(1);
  }
}
