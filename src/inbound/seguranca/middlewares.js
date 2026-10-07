import { limitarTaxa } from '../auth/rateLimit.js';
import { envInt } from './env.js';
import { PESO, bloquearBanidos, detectarVarredura, infracao } from './jail.js';
import { iniciarMonitorSobrecarga, recusarSeSobrecarregado } from './sobrecarga.js';

/**
 * Camada de segurança aplicada a TODAS as requisições do inbound, na ordem:
 *  1. IP banido pelo jail → 403 na hora
 *  2. varredura de robôs (/.env, /wp-login.php...) → 404 + ban rápido
 *  3. cabeçalhos de segurança
 *  4. sobrecarga → 503 para o que não é essencial
 *  5. limite global por IP (webhooks da Meta/Evolution ficam de fora)
 */

/**
 * Webhooks e rotas operacionais: nunca entram no limite global nem são
 * recusadas por sobrecarga (Meta/Evolution mandam muitos eventos do mesmo IP).
 */
export function criarFiltroEssencial(inboundConfig) {
  const exatos = new Set(
    [
      '/health',
      '/token',
      '/integracao',
      inboundConfig.eventsMetaPath,
      inboundConfig.evolutionWebhookLegacyPath,
      ...Object.values(inboundConfig.metaApiPaths ?? {}),
    ].filter(Boolean),
  );
  const prefixos = [inboundConfig.evolutionWebhookPath].filter(Boolean);
  return (req) => exatos.has(req.path) || prefixos.some((p) => req.path === p || req.path.startsWith(`${p}/`));
}

export function cabecalhosSeguranca({ https }) {
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'geolocation=(), payment=(), usb=()');
    if (https) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Impede que as telas sejam embutidas em sites de terceiros (clickjacking).
    // A página de vendas pública fica livre.
    if (req.path !== '/pv') {
      res.set('X-Frame-Options', 'SAMEORIGIN');
      res.set('Content-Security-Policy', "frame-ancestors 'self'");
    }
    next();
  };
}

export function aplicarSeguranca(app, { inboundConfig }) {
  const essencial = criarFiltroEssencial(inboundConfig);
  const limiteGlobal = limitarTaxa({
    nome: 'global',
    max: envInt('API_LIMITE_MINUTO', 300),
    janelaMs: 60_000,
  });

  iniciarMonitorSobrecarga();

  app.use(bloquearBanidos());
  app.use(detectarVarredura());
  app.use(cabecalhosSeguranca({ https: inboundConfig.backUrl.startsWith('https://') }));
  app.use(recusarSeSobrecarregado({ essencial }));
  app.use((req, res, next) => (essencial(req) ? next() : limiteGlobal(req, res, next)));
}

/** 404 conta pontos no jail (robôs testando URLs), exceto arquivos que navegadores pedem sozinhos. */
export function registrar404(req) {
  if (/^\/(favicon\.ico|robots\.txt|apple-touch-icon.*\.png|\.well-known\/.*)$/i.test(req.path)) return;
  infracao(req, PESO.NAO_ENCONTRADO, '404');
}
