// Captura uma tela REAL do sistema (public/pages/*.html) já renderizada com dados de exemplo.
//
// A página roda com os próprios scripts; o Supabase e o backend são bloqueados (a página não
// redireciona para o login), e um script de preparo chama as funções de renderização da própria
// tela com dados fictícios. O DOM resultante é salvo sem <script>, com fontes locais e sem
// transições — vira um "cenário" estático que os vídeos animam.
//
// Uso: node telas/capturar.mjs <pasta-das-paginas> <pagina> <dados.js> <preparo.js> <saida.html> [--w 1600 --h 900] [--log]
//   dados.js   roda antes da página (define window.__FIX, cookies etc.)
//   preparo.js roda depois que a página carregou (ex.: abrir uma conversa ou um modal)
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [srcDir, page, fixFile, setupFile, outFile] = process.argv.slice(2);
const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const W = Number(opt('w', 1600)), H = Number(opt('h', 900));

const SUBST = {
  __HUB_COR_RGB__: '37, 211, 102', __HUB_COR__: '25D366', __HUB_NOME__: 'HubLabel',
  __HUB_TELEFONE_SUPORTE__: '5500000000000',
};
const server = http.createServer((req, res) => {
  const p = join(srcDir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  let body = readFileSync(p);
  if (extname(p) === '.html') {
    let s = body.toString();
    for (const [k, v] of Object.entries(SUBST)) s = s.split(k).join(v);
    s = s.replace(/__HUB_[A-Z_]+__/g, '');
    body = s;
  }
  res.writeHead(200, { 'content-type': extname(p) === '.css' ? 'text/css' : 'text/html; charset=utf-8' });
  res.end(body);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ['--lang=pt-BR'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
// Tema claro (a tela lê o cookie darkMode)
await ctx.addCookies([{ name: 'darkMode', value: 'false', url: `http://127.0.0.1:${port}` }]);
const FAKE = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
for (const f of fixFile.split(',')) await ctx.addInitScript({ content: readFileSync(resolve(f), 'utf8') });
const pg = await ctx.newPage();
pg.on('console', (m) => { if (process.argv.includes('--console')) console.log('[console]', m.text().slice(0, 200)); });
pg.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 160)));
// Bibliotecas de CDN servidas localmente (a captura não depende da rede)
const LIB = (f) => readFileSync(new URL('./libs/' + f, import.meta.url), 'utf8');
const twCss = process.env.TW_CSS && existsSync(process.env.TW_CSS) ? readFileSync(process.env.TW_CSS, 'utf8') : '';
await pg.route('**/*', (route) => {
  const u = route.request().url();
  // API do WhatsApp (Evolution/UazAPI): conexões de exemplo sempre "conectadas"
  if (/\/instance\/(connectionState|status)/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ instance: { state: 'open' }, state: 'open', connected: true }) });
  if (/cdn\.tailwindcss\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.tailwind={config:{}};(function(){var s=document.createElement('style');s.setAttribute('data-tailwind','');s.textContent=${JSON.stringify(twCss)};document.head.appendChild(s);})();` });
  if (/Chart\.js|chart\.min\.js/i.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: LIB('chart.min.js') });
  if (/alpinejs/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: LIB('alpine.min.js') });
  if (u.startsWith(`http://127.0.0.1:${port}`)) {
    // páginas e CSS locais; qualquer chamada ao backend (rotas sem arquivo) responde JSON vazio
    const path = new URL(u).pathname;
    if (existsSync(join(srcDir, path.replace(/^\/+/, ''))) && path !== '/') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify((globalThis.__API || {})[path] ?? {}) });
  }
  if (/supabase-js/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE });
  if (/supabase|esm\.sh/.test(u)) return route.abort();
  if (/fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare|cdn\.tailwindcss|cdn\.jsdelivr\.net\/npm\/(alpinejs|chart)/.test(u)) return route.continue();
  return route.abort();
});
await pg.goto(`http://127.0.0.1:${port}/${page}`, { waitUntil: 'domcontentloaded' });
await pg.mouse.move(W - 4, H - 4); // longe do menu lateral (ele abre no hover)
await pg.waitForTimeout(2500);
await pg.evaluate(readFileSync(resolve(setupFile), 'utf8'));
await pg.waitForTimeout(1500);
if (process.argv.includes('--log')) {
  const q = await pg.evaluate(() => window.__Q || []);
  const seen = new Map();
  q.forEach((x) => { const k = x.rpc ? 'rpc ' + x.rpc : `${x.t} ${x.mode} [${(x.cols || '').toString().slice(0, 80)}] ${JSON.stringify(x.f)} → ${x.n}`; seen.set(k, (seen.get(k) || 0) + 1); });
  for (const [k, n] of seen) console.log(n > 1 ? `${n}× ` : '', k);
}

await pg.mouse.move(W - 4, H - 4);
await pg.evaluate(() => document.querySelectorAll('.sidebar').forEach((s) => s.classList.remove('sidebar-expanded', 'expanded', 'hover')));
await pg.waitForTimeout(400);
const VENDOR = relative(dirname(resolve(outFile)), fileURLToPath(new URL('./vendor', import.meta.url))).split('\\').join('/');
const html = await pg.evaluate((VENDOR) => {
  document.querySelectorAll('canvas').forEach((c) => {
    try { const img = document.createElement('img'); img.src = c.toDataURL(); img.style.cssText = c.style.cssText; img.width = c.width; img.height = c.height; img.className = c.className; c.replaceWith(img); } catch {}
  });
  // valores preenchidos por JS viram atributos (o HTML salvo guarda o que está na tela)
  document.querySelectorAll('input').forEach((el) => {
    if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked'); }
    else if (el.type !== 'file') el.setAttribute('value', el.value);
    // o Chromium sem interface mostra hora em AM/PM; no sistema (pt-BR) aparece 24h
    if (el.type === 'time') { el.setAttribute('type', 'text'); el.style.minWidth = '5.5em'; }
  });
  document.querySelectorAll('textarea').forEach((el) => { el.textContent = el.value; });
  document.querySelectorAll('select').forEach((el) => { [...el.options].forEach((o) => { if (o.selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }); });
  document.querySelectorAll('script').forEach((s) => s.remove());
  // logo white-label: marca neutra no lugar da imagem configurada pelo cliente
  const LOGO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="11" fill="#25D366"/><path d="M12 28l1.6-4.4A9 9 0 1 1 17 27.7z" fill="none" stroke="#04150a" stroke-width="2.6" stroke-linejoin="round"/></svg>');
  document.querySelectorAll('img').forEach((im) => { const src = im.getAttribute('src') || ''; if (!src || /logo|favicon/i.test(im.className + ' ' + im.id) || /^(https?:\/\/127|\/)$/.test(src)) { im.setAttribute('src', LOGO); im.style.objectFit = 'contain'; } });
  document.querySelectorAll('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"], link[href*="font-awesome"], link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach((l) => l.remove());
  const head = document.head;
  head.insertAdjacentHTML('afterbegin', `<link rel="stylesheet" href="${VENDOR}/fonts.css"><link rel="stylesheet" href="${VENDOR}/fa/all.min.css">`);
  head.insertAdjacentHTML('beforeend', '<style data-motion>*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent}html,body{overflow:hidden!important}</style>');
  // CSS de arquivos locais (ex.: dropdowns-global.css) vira inline
  return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
}, VENDOR);
// Inclui os CSS locais referenciados
let out = html.replace(/<link rel="stylesheet" href="([^":]+?\.css)">/g, (m, href) => {
  if (href.includes('vendor/')) return m;
  const p = join(srcDir, href);
  return existsSync(p) ? `<style>${readFileSync(p, 'utf8')}</style>` : '';
});
writeFileSync(outFile, out);
await pg.screenshot({ path: outFile.replace(/\.html$/, '.png') });
console.log('ok →', outFile);
await browser.close();
server.close();
