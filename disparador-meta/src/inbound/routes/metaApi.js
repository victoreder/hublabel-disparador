import { logger } from '../../logger.js';
import { handleConnectMeta } from '../meta/connect.js';
import { HttpError } from '../meta/httpError.js';
import { handlePerfilMeta } from '../meta/perfil.js';
import { runTokenRenewalCron, scheduleTokenRenewalCron, handleRenewToken } from '../meta/renewToken.js';
import { handleCreateTemplate, handleDeleteTemplate } from '../meta/templates.js';

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req.body ?? {}, req.app.locals.inboundConfig);
      res.status(200).json(result);
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 500;
      if (status >= 500) {
        logger.error('Erro em rota Meta API', { message: error.message, stack: error.stack });
      }
      res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      });
    }
  };
}

export function registerMetaApiRoutes(app, { paths, inboundConfig }) {
  app.post(paths.token, asyncRoute(handleConnectMeta));
  app.post(paths.criarTemplate, asyncRoute(handleCreateTemplate));
  app.post(paths.excluirTemplate, asyncRoute(handleDeleteTemplate));
  app.post(paths.perfil, asyncRoute(handlePerfilMeta));
  app.post(paths.renovarToken, asyncRoute(handleRenewToken));

  app.post(paths.renovarTokenCron, async (req, res) => {
    try {
      const result = await runTokenRenewalCron(inboundConfig);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erro no cron manual de renovacao de token', { message: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

export function startMetaTokenRenewalCron(inboundConfig) {
  scheduleTokenRenewalCron(inboundConfig, {
    hour: inboundConfig.tokenRenewalCronHour,
    minute: inboundConfig.tokenRenewalCronMinute,
    onRun: (result) => {
      logger.info('Cron renovacao token Meta', result);
    },
  });

  logger.info('Cron renovacao token Meta agendado', {
    hour: inboundConfig.tokenRenewalCronHour,
    minute: inboundConfig.tokenRenewalCronMinute,
  });
}
