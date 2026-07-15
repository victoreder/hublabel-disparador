import { logger } from '../../logger.js';
import { parseMetaWebhookBody } from '../eventsmeta/parseEvents.js';
import { processEventsAsync } from '../eventsmeta/processEvents.js';
import { verifyMetaWebhook } from '../eventsmeta/verify.js';

export function registerEventsMetaRoutes(app, { path, inboundConfig }) {
  app.get(path, async (req, res) => {
    try {
      const result = await verifyMetaWebhook(req.query);
      if (result.verified) {
        return res.status(200).type('text/plain').send(result.challenge);
      }
      return res.status(403).json({ error: 'forbidden' });
    } catch (error) {
      logger.error('Erro na verificação GET eventsmeta', { message: error.message });
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post(path, (req, res) => {
    res.status(200).type('text/plain').send('EVENT_RECEIVED');

    const events = parseMetaWebhookBody(req.body);
    if (!events.length) return;

    processEventsAsync(events, inboundConfig).catch((error) => {
      logger.error('Erro no processamento assíncrono eventsmeta', {
        message: error.message,
        stack: error.stack,
      });
    });
  });
}
