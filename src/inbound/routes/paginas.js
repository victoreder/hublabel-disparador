import { logger } from '../../logger.js';
import { personalizarPaginaIa } from '../acoes/ia.js';
import { buscarPaginaVendas, criarPaginaVendas, salvarPaginaVendas } from '../paginas/paginaVendas.js';
import { salvarPersonalizacao } from '../paginas/personalizacao.js';
import { loadPageTemplates, renderPage, sendHtml, warnIfAnonKeyMissing } from '../paginas/render.js';
import { protegida } from '../auth/autenticar.js';
import { postJson, responder } from './responder.js';

/**
 * Telas do sistema (antes servidas pelo n8n) + página de vendas + personalização.
 * Cada arquivo public/pages/<slug>.html vira GET /<slug>
 * (URL pública: BACK_URL/<slug>, ex.: https://dominio/webhook/login).
 */
export function registerPaginasRoutes(app, { inboundConfig }) {
  warnIfAnonKeyMissing();
  const slugs = [...loadPageTemplates().keys()];

  for (const slug of slugs) {
    app.get(`/${slug}`, async (req, res, next) => {
      try {
        const entry = await renderPage(slug, inboundConfig);
        if (!entry) return next();
        return sendHtml(req, res, entry);
      } catch (error) {
        return next(error);
      }
    });
  }

  app.get('/pv', async (_req, res, next) => {
    try {
      const pagina = await buscarPaginaVendas();
      if (!pagina) return res.status(404).type('text/plain').send('Página de vendas ainda não criada.');
      res.set('Cache-Control', 'no-cache');
      return res.type('html').send(pagina.html);
    } catch (error) {
      return next(error);
    }
  });

  // Admin → aba Página de vendas. Sem página criada responde {} (a tela mostra "Criar").
  app.get('/buscar-pv', (req, res) =>
    responder(res, async () => {
      const pagina = await buscarPaginaVendas();
      return pagina ? { id: String(pagina.id), html: pagina.html } : {};
    }),
  );

  const somenteSuperAdmin = (path) => ({ middlewares: [protegida(path)] });

  postJson(
    app,
    '/criar-pv',
    async () => {
      const pagina = await criarPaginaVendas();
      return { ok: true, id: String(pagina.id) };
    },
    somenteSuperAdmin('/criar-pv'),
  );

  postJson(
    app,
    '/personalizar-pv',
    async (req) => {
      await salvarPaginaVendas(req.body?.html);
      return { ok: true };
    },
    somenteSuperAdmin('/personalizar-pv'),
  );

  postJson(
    app,
    '/personalizar-pagina',
    (req) => personalizarPaginaIa(req.body),
    somenteSuperAdmin('/personalizar-pagina'),
  );

  postJson(
    app,
    '/personalizar-saas',
    async (req) => {
      const personalizacao = await salvarPersonalizacao(req.body ?? {});
      logger.info('[personalizacao] atualizada', {
        nome: personalizacao.nome,
        cor: personalizacao.cor,
        por: req.usuario?.authUserId ?? 'api-key',
      });
      return { ok: true, personalizacao };
    },
    somenteSuperAdmin('/personalizar-saas'),
  );

  logger.info('[paginas] telas registradas', { total: slugs.length, slugs });
}
