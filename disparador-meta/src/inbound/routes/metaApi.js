import { logger } from '../../logger.js';
import { handleConnectMeta } from '../meta/connect.js';
import { HttpError } from '../meta/httpError.js';
import { handlePerfilMeta } from '../meta/perfil.js';
import { runTokenRenewalCron, scheduleTokenRenewalCron, handleRenewToken } from '../meta/renewToken.js';
import { handleCreateTemplate, handleDeleteTemplate } from '../meta/templates.js';

function sanitizeMetaTokenBody(body) {
  const b = body ?? {};
  return {
    conexaoId: b.conexaoId ?? b.conexao_id ?? null,
    contaId: b.contaId ?? b.conta_id ?? null,
    waba_id: b.waba_id ?? null,
    phone_number_id: b.phone_number_id ?? null,
    business_id: b.business_id ?? null,
    NomeConexao: b.NomeConexao ?? b.nome ?? null,
    temCode: Boolean(b.code),
  };
}

function sanitizeRenewBody(body) {
  const b = body ?? {};
  return {
    conexaoId: b.conexaoId ?? b.conexao_id ?? null,
    phone_number_id: b.phone_number_id ?? null,
  };
}

function asyncRoute(handler, { routeName, sanitizeBody } = {}) {
  return async (req, res) => {
    const startedAt = Date.now();
    const safeBody = sanitizeBody ? sanitizeBody(req.body) : undefined;

    logger.info(`[${routeName || 'meta-api'}] hit`, {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      contentType: req.headers['content-type'] || null,
      body: safeBody ?? {},
      bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
    });

    try {
      const result = await handler(req.body ?? {}, req.app.locals.inboundConfig);

      if (routeName) {
        logger.info(`[${routeName}] ok`, {
          durationMs: Date.now() - startedAt,
          ...(result && typeof result === 'object' ? result : { result }),
        });
      }

      res.status(200).json(result);
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 500;
      const logPayload = {
        durationMs: Date.now() - startedAt,
        status,
        message: error instanceof Error ? error.message : String(error),
        body: safeBody,
      };

      if (status >= 500) {
        logger.error(`[${routeName || 'meta-api'}] erro`, {
          ...logPayload,
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else {
        logger.warn(`[${routeName || 'meta-api'}] rejeitado`, logPayload);
      }

      res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      });
    }
  };
}

export function registerMetaApiRoutes(app, { paths, inboundConfig }) {
  logger.info('[meta-api] registrando rotas', paths);

  app.post(
    paths.token,
    asyncRoute(handleConnectMeta, { routeName: 'meta-token', sanitizeBody: sanitizeMetaTokenBody }),
  );
  app.post(paths.criarTemplate, asyncRoute(handleCreateTemplate, { routeName: 'meta-criar-template' }));
  app.post(paths.excluirTemplate, asyncRoute(handleDeleteTemplate, { routeName: 'meta-excluir-template' }));
  app.post(paths.perfil, asyncRoute(handlePerfilMeta, { routeName: 'meta-perfil' }));
  app.post(
    paths.renovarToken,
    asyncRoute(handleRenewToken, { routeName: 'meta-renovar-token', sanitizeBody: sanitizeRenewBody }),
  );

  app.post(paths.renovarTokenCron, async (req, res) => {
    const startedAt = Date.now();
    logger.info('[meta-renovar-token-cron] request manual');
    try {
      const result = await runTokenRenewalCron(inboundConfig);
      logger.info('[meta-renovar-token-cron] ok', {
        durationMs: Date.now() - startedAt,
        ...result,
      });
      res.status(200).json(result);
    } catch (error) {
      logger.error('[meta-renovar-token-cron] erro', {
        durationMs: Date.now() - startedAt,
        message: error.message,
        stack: error.stack,
      });
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

export function startMetaTokenRenewalCron(inboundConfig) {
  scheduleTokenRenewalCron(inboundConfig, {
    hour: inboundConfig.tokenRenewalCronHour,
    minute: inboundConfig.tokenRenewalCronMinute,
    onRun: (result) => {
      logger.info('[meta-renovar-token-cron] execucao agendada', result);
    },
  });

  logger.info('[meta-renovar-token-cron] agendado', {
    hour: inboundConfig.tokenRenewalCronHour,
    minute: inboundConfig.tokenRenewalCronMinute,
  });
}
