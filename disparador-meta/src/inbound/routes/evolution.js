import { handleEvolutionWebhook } from '../evolution/handler.js';

export function registerEvolutionRoutes(app, { path }) {
  app.post(path, async (req, res) => {
    try {
      const inboundConfig = req.app.locals.inboundConfig;
      const result = await handleEvolutionWebhook(req, inboundConfig);
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}
