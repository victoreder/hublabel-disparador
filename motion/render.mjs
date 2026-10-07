// Renderizador genérico: abre o HTML do vídeo no Chromium, chama window.render(t)
// quadro a quadro e envia os quadros para o ffmpeg. A página precisa expor
// window.DURATION (segundos), window.render(t) e window.__ready (Promise).
//
// Uso:
//   node render.mjs anuncio-agente-ia.html saida.mp4 [--fps 30] [--audio trilha.wav]
//                   [--from 0] [--to <dur>] [--frames 2,5.5,10]  (só PNGs de conferência)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve, dirname, basename, join, extname } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const [htmlPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!htmlPath) {
  console.error('uso: node render.mjs <video.html> <saida.mp4> [--fps 30] [--audio a.wav] [--frames t1,t2]');
  process.exit(1);
}

const fps = Number(opt('fps', 30));
const audio = opt('audio');
const framesOpt = opt('frames');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--font-render-hinting=none', '--disable-lcd-text', '--lang=pt-BR'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
page.on('pageerror', (e) => console.error('[página]', e.message));
// Servidor HTTP local: as telas capturadas entram em <iframe> e precisam da mesma origem
// para o vídeo animar o DOM delas (file:// não permite).
const ROOT = dirname(resolve(htmlPath));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
// Sem rede externa no render: tudo precisa ser local
await page.route('**/*', (route) => (route.request().url().startsWith('http://127.0.0.1:') || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
await page.goto(`http://127.0.0.1:${server.address().port}/${basename(htmlPath)}`, { waitUntil: 'load' });
const { width, height, duration } = await page.evaluate(async () => {
  await window.__ready;
  return { width: window.WIDTH || 1920, height: window.HEIGHT || 1080, duration: window.DURATION };
});
if (width !== 1920 || height !== 1080) await page.setViewportSize({ width, height });

const shot = async (t) => {
  await page.evaluate((tt) => window.render(tt), t);
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
};

if (framesOpt) {
  // Modo conferência: quadros estáticos em PNG ao lado da saída.
  const dir = resolve(outPath || 'quadros');
  mkdirSync(dir, { recursive: true });
  for (const t of framesOpt.split(',').map(Number)) {
    const buf = await shot(t);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/${basename(htmlPath, '.html')}-${t.toFixed(2)}s.png`, buf);
  }
  await browser.close();
  server.close();
  process.exit(0);
}

const from = Number(opt('from', 0));
const to = Number(opt('to', duration));
const total = Math.round((to - from) * fps);
mkdirSync(dirname(resolve(outPath)), { recursive: true });

const ffArgs = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
if (audio) ffArgs.push('-ss', String(from), '-i', audio);
ffArgs.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
if (audio) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
ffArgs.push(outPath);
const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'inherit'] });
const done = new Promise((ok, fail) => ff.on('close', (c) => (c === 0 ? ok() : fail(new Error(`ffmpeg saiu com ${c}`)))));

const t0 = Date.now();
for (let i = 0; i < total; i++) {
  const buf = await shot(from + i / fps);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % fps === 0) process.stdout.write(`\r${i}/${total} quadros (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
ff.stdin.end();
await done;
await browser.close();
server.close();
console.log(`\nok → ${outPath}`);
