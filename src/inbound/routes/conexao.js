import { logger } from '../../logger.js';
import { HttpError } from '../meta/httpError.js';
import { criarConexaoNaoOficial } from '../conexao/criar.js';
import {
  contarParticipantesGrupo,
  exportarParticipantesGrupo,
  listarGruposWhatsApp,
  puxarContatosWpp,
} from '../conexao/grupos.js';
import { salvarFotoETelefoneConexao } from '../conexao/salvarFoto.js';
import { sincronizarContatosWhatsApp } from '../conexao/sincronizarContatos.js';

function normalizeAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function actionFromRequest(req) {
  return normalizeAction(
    req.body?.acao ??
      req.body?.action ??
      req.query?.acao ??
      req.query?.action,
  );
}

function isWebhookShape(body = {}) {
  return Boolean(
    body.event ||
      body.EventType ||
      body.instance ||
      body.message ||
      (body.data && typeof body.data === 'object'),
  );
}

function isActionRequest(req, actions) {
  const action = actionFromRequest(req);
  if (!actions.includes(action)) return false;
  if (isWebhookShape(req.body ?? {})) return false;
  return true;
}

export function isCriarConexaoRequest(req) {
  return isActionRequest(req, ['criarconexao']);
}

export function isSalvarFotoRequest(req) {
  return isActionRequest(req, ['salvarfoto', 'salvarfotoetelefone']);
}

export function isSincronizarContatosRequest(req) {
  return isActionRequest(req, ['sincronizarcontatos', 'puxarcontatos', 'synccontatos']);
}

export function isListarGruposRequest(req) {
  return isActionRequest(req, ['listargrupos', 'puxargruposwpp', 'puxargrupos']);
}

export function isContarParticipantesRequest(req) {
  return isActionRequest(req, ['contarparticipantes']);
}

export function isExportarParticipantesRequest(req) {
  return isActionRequest(req, ['exportarparticipantes']);
}

export function isPuxarContatosWppRequest(req) {
  return isActionRequest(req, ['puxarcontatoswpp']);
}

async function runHandler(name, fn, req, res) {
  const startedAt = Date.now();
  try {
    const result = await fn(req.body ?? {}, req.app.locals.inboundConfig);
    logger.info(`[${name}] ok`, {
      durationMs: Date.now() - startedAt,
      provedorApi: result?.provedorApi ?? null,
      total: result?.total ?? result?.participantes ?? null,
    });
    return res.status(200).json(result);
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    const log = {
      durationMs: Date.now() - startedAt,
      status,
      message: error instanceof Error ? error.message : String(error),
    };
    if (status >= 500) logger.error(`[${name}] erro`, log);
    else logger.warn(`[${name}] rejeitado`, log);
    return res.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
}

export function handleCriarConexaoRequest(req, res) {
  return runHandler('criar-conexao', criarConexaoNaoOficial, req, res);
}

export function handleSalvarFotoRequest(req, res) {
  return runHandler('salvar-foto', salvarFotoETelefoneConexao, req, res);
}

export function handleSincronizarContatosRequest(req, res) {
  return runHandler('sync-contatos', sincronizarContatosWhatsApp, req, res);
}

export function handleListarGruposRequest(req, res) {
  return runHandler('listar-grupos', listarGruposWhatsApp, req, res);
}

export function handleContarParticipantesRequest(req, res) {
  return runHandler('contar-participantes', contarParticipantesGrupo, req, res);
}

export function handleExportarParticipantesRequest(req, res) {
  return runHandler('exportar-participantes', exportarParticipantesGrupo, req, res);
}

export function handlePuxarContatosWppRequest(req, res) {
  return runHandler('puxar-contatos-wpp', puxarContatosWpp, req, res);
}
