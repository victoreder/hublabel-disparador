import { logger } from '../../logger.js';
import { parseMetaWebhookBody, summarizeMetaWebhookEvents } from '../eventsmeta/parseEvents.js';
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
    const summary = summarizeMetaWebhookEvents(events);

    logger.info('[eventsmeta] webhook recebido', {
      object: req.body?.object ?? null,
      eventsCount: events.length,
      events: summary,
      // Payload bruto para depurar se sent/read estão chegando
      body: req.body ?? null,
    });

    if (!events.length) {
      logger.warn('[eventsmeta] webhook sem events parseáveis', {
        bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : null,
      });
      return;
    }

    processEventsAsync(events, inboundConfig).catch((error) => {
      logger.error('Erro no processamento assíncrono eventsmeta', {
        message: error.message,
        stack: error.stack,
      });
    });
  });
}
