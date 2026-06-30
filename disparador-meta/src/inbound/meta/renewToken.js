import {
  fetchAllConexoesApiOficial,
  fetchConfigApiOficial,
  fetchConexaoApiOficialById,
  fetchConexaoApiOficialByPhone,
  updateConexaoApiOficial,
} from '../../supabase.js';
import { logger } from '../../logger.js';
import { exchangeLongLivedToken } from './graph.js';
import { HttpError } from './httpError.js';

export function parseRenewInput(body) {
  const conexaoId = body.conexaoId || body.conexao_id || null;
  const phoneNumberId = body.phone_number_id || null;

  if (!conexaoId && !phoneNumberId) {
    throw new HttpError('Informe conexaoId ou phone_number_id.');
  }

  return { conexaoId, phone_number_id: phoneNumberId };
}

export async function renewConexaoToken(conexao, { metaGraphApiVersion }) {
  logger.info('[meta-renovar-token] iniciando', {
    conexaoId: conexao?.id,
    NomeConexao: conexao?.NomeConexao,
    phone_number_id: conexao?.phone_number_id,
    expires_at: conexao?.expires_at ?? null,
    temAccessToken: Boolean(conexao?.access_token),
  });

  const config = await fetchConfigApiOficial('app_id, app_secret');

  if (!config?.app_id || !config?.app_secret) {
    throw new HttpError('Config API Oficial incompleta em SAAS_Config_ApiOficial.');
  }
  if (!conexao?.access_token) {
    throw new HttpError('Conexao nao encontrada em SAAS_Conexoes.');
  }
  if (!conexao.apiOficial) {
    throw new HttpError('Conexao nao e API Oficial (apiOficial=false).');
  }

  const tokenRes = await exchangeLongLivedToken({
    version: metaGraphApiVersion,
    appId: config.app_id,
    appSecret: config.app_secret,
    shortLivedToken: conexao.access_token,
  });

  const expiresAt = tokenRes.expires_in
    ? new Date(Date.now() + Number(tokenRes.expires_in) * 1000).toISOString()
    : null;

  logger.info('[meta-renovar-token] token renovado', {
    conexaoId: conexao.id,
    expires_in: tokenRes.expires_in || null,
    expires_at: expiresAt,
  });

  return {
    conexaoId: conexao.id,
    access_token: tokenRes.access_token,
    expires_in: tokenRes.expires_in || null,
    expires_at: expiresAt,
  };
}

export async function handleRenewToken(body, opts) {
  const input = parseRenewInput(body);
  const conexao = input.conexaoId
    ? await fetchConexaoApiOficialById(input.conexaoId)
    : await fetchConexaoApiOficialByPhone(input.phone_number_id);

  const renewed = await renewConexaoToken(conexao, opts);

  await updateConexaoApiOficial(renewed.conexaoId, {
    access_token: renewed.access_token,
    expires_in: renewed.expires_in,
    expires_at: renewed.expires_at,
  });

  return {
    ok: true,
    conexaoId: renewed.conexaoId,
    expires_in: renewed.expires_in,
    expires_at: renewed.expires_at,
    renewed_at: new Date().toISOString(),
  };
}

const RENEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function filterConexoesExpiring(rows) {
  const now = Date.now();
  return (rows ?? []).filter((row) => {
    if (!row?.id || !row?.access_token) return false;
    if (!row.expires_at) return true;
    const expiresAt = new Date(row.expires_at).getTime();
    if (Number.isNaN(expiresAt)) return true;
    return expiresAt - now <= RENEW_WINDOW_MS;
  });
}

export async function runTokenRenewalCron(opts) {
  const rows = await fetchAllConexoesApiOficial();
  const toRenew = filterConexoesExpiring(rows);

  logger.info('[meta-renovar-token-cron] verificacao', {
    totalConexoes: rows?.length ?? 0,
    paraRenovar: toRenew.length,
  });

  if (!toRenew.length) {
    return {
      ok: true,
      total: 0,
      renewed: 0,
      failed: 0,
      message: 'Nenhuma conexao para renovar',
      checked_at: new Date().toISOString(),
    };
  }

  const results = [];

  for (const row of toRenew) {
    try {
      const renewed = await renewConexaoToken(row, opts);
      await updateConexaoApiOficial(renewed.conexaoId, {
        access_token: renewed.access_token,
        expires_in: renewed.expires_in,
        expires_at: renewed.expires_at,
      });
      results.push({
        ok: true,
        conexaoId: renewed.conexaoId,
        NomeConexao: row.NomeConexao || null,
        expires_at: renewed.expires_at,
        renewed_at: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao renovar token';
      logger.warn('[meta-renovar-token-cron] falha em conexao', {
        conexaoId: row.id,
        NomeConexao: row.NomeConexao || null,
        message,
      });
      results.push({
        ok: false,
        conexaoId: row.id,
        NomeConexao: row.NomeConexao || null,
        error: message,
      });
    }
  }

  const renewed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return {
    ok: failed === 0,
    total: results.length,
    renewed,
    failed,
    results,
    finished_at: new Date().toISOString(),
  };
}

export function scheduleTokenRenewalCron(opts, { hour = 3, minute = 0, onRun }) {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delayMs = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        const result = await runTokenRenewalCron(opts);
        onRun?.(result);
      } catch (error) {
        onRun?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      scheduleNext();
    }, delayMs);
  };

  scheduleNext();
}
