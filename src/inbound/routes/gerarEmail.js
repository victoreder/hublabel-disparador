import { logger } from '../../logger.js';
import {
  addTokensConta,
  fetchCamposPersonalizados,
  fetchCreditosConta,
} from '../../supabase.js';
import { gerarEmailHtmlComIa } from '../email/gerarHtml.js';
import { HttpError } from '../meta/httpError.js';

function normalizeAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isGerarEmailAction(value) {
  const acao = normalizeAction(value);
  return (
    acao === 'geraremail' ||
    acao === 'geraremailhtml' ||
    acao === 'gerarhtmlemail' ||
    acao === 'emailia'
  );
}

export function isGerarEmailRequest(req) {
  const path = String(req.path || req.originalUrl || '');
  if (path.includes('gerar-email')) return true;

  const query = req.query ?? {};
  if (isGerarEmailAction(query.acao ?? query.action)) return true;

  const body = req.body ?? {};
  if (isGerarEmailAction(body.acao ?? body.action)) return true;
  return false;
}

function uuidOrNull(value) {
  const raw = String(value ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return null;
  }
  return raw;
}

function contaTemCredito(conta) {
  if (!conta) return false;
  if (conta.planoQntCreditos == null) return true;
  return Number(conta.total_creditos || 0) < Number(conta.planoQntCreditos);
}

async function gerarEmailFromBody(body = {}) {
  const contaId = uuidOrNull(body.contaId ?? body.userId ?? body.conta_id);
  const instrucoes = String(body.instrucoes ?? body.instrucao ?? body.prompt ?? '').trim();
  const modelo = body.modelo ?? body.model ?? null;

  if (!contaId) {
    throw new HttpError('contaId é obrigatório (UUID da conta)', 400);
  }
  if (!instrucoes) {
    throw new HttpError('instrucoes é obrigatório', 400);
  }

  const conta = await fetchCreditosConta(contaId);
  if (!conta) {
    throw new HttpError('Conta não encontrada', 404);
  }
  if (!contaTemCredito(conta)) {
    throw new HttpError('Créditos de IA esgotados para esta conta', 402);
  }

  const camposPersonalizados = await fetchCamposPersonalizados(contaId);
  const gerado = await gerarEmailHtmlComIa({ instrucoes, camposPersonalizados, modelo });

  let debito = null;
  try {
    debito = await addTokensConta({ contaId, qntTokens: gerado.creditos });
  } catch (error) {
    logger.warn('[gerar-email] falha ao debitar créditos', { contaId, message: error.message });
  }

  return {
    ok: true,
    html: gerado.html,
    modelo: gerado.modelo,
    creditos: gerado.creditos,
    tokens: gerado.totalTokens,
    contaId,
  };
}

export function handleGerarEmailRequest(req, res) {
  const startedAt = Date.now();
  const body = req.body ?? {};

  logger.info('[gerar-email] hit', {
    method: req.method,
    path: req.path,
    contaId: body.contaId ?? body.userId ?? null,
    hasInstrucoes: Boolean(body.instrucoes ?? body.instrucao ?? body.prompt),
  });

  gerarEmailFromBody(body)
    .then((result) => {
      logger.info('[gerar-email] ok', {
        durationMs: Date.now() - startedAt,
        contaId: result.contaId,
        creditos: result.creditos,
        htmlChars: result.html?.length ?? 0,
      });
      res.status(200).json(result);
    })
    .catch((error) => {
      const status = error instanceof HttpError ? error.statusCode : 500;
      const log = {
        durationMs: Date.now() - startedAt,
        status,
        contaId: body.contaId ?? body.userId ?? null,
        message: error instanceof Error ? error.message : String(error),
      };
      if (status >= 500) logger.error('[gerar-email] erro', { ...log, stack: error.stack });
      else logger.warn('[gerar-email] rejeitado', log);

      res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      });
    });
}

export function registerGerarEmailRoutes(app, { path, parentPath }) {
  logger.info('[gerar-email] registrando sub-rota', { path, parentPath });
  app.post(path, handleGerarEmailRequest);
}
