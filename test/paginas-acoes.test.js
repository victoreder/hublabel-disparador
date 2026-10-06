import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_URL ??= 'http://localhost';

const { toTemplate } = await import('../scripts/extract-n8n-pages.mjs');
const { applyReplacements, buildReplacements } = await import('../src/inbound/paginas/render.js');
const { corParaRgb, normalizarCorHex, sanitizarNome, sanitizarTelefone, sanitizarUrl } = await import(
  '../src/inbound/paginas/personalizacao.js'
);
const { mapearCamposLead, mapearCamposPagamento, montarMensagemLead } = await import(
  '../src/inbound/acoes/webhookEntrada.js'
);
const { buildTemplatePayload } = await import('../src/inbound/acoes/enviarTemplate.js');
const { hojeMaisDias } = await import('../src/inbound/acoes/usuarios.js');

const PAGES_DIR = new URL('../public/pages/', import.meta.url);

test('extração troca domínios, anon key e personalização por placeholders', () => {
  const anon =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') +
    '.assinatura';
  const html = [
    "const SUPABASE_URL = 'https://hxumiciyohbianfnzfyk.supabase.co'",
    `const KEY = '${anon}'`,
    '<img src="https://hxumiciyohbianfnzfyk.supabase.co/storage/v1/object/public/arquivos/LOGO%20PRINCIPAL.png">',
    "fetch('https://webhook2.victoreder.com.br/webhook/uploadmedia')",
    "let host = 'webhook2.victoreder.com.br'",
    'color: #25D366; rgba(37, 211, 102, .2); <title>Disparamator</title> wa.me/5548984549300',
  ].join('\n');

  const out = toTemplate(html);
  assert.match(out, /'__HUB_SUPABASE_URL__'/);
  assert.match(out, /'__HUB_SUPABASE_ANON_KEY__'/);
  assert.match(out, /src="__HUB_LOGO_URL__"/);
  assert.match(out, /'__HUB_BACK_URL__\/uploadmedia'/);
  assert.match(out, /'__HUB_BACK_HOST__'/);
  assert.match(out, /#__HUB_COR__; rgba\(__HUB_COR_RGB__, \.2\); <title>__HUB_NOME__<\/title> wa\.me\/__HUB_TELEFONE_SUPORTE__/);
});

test('extração recusa JWT que não seja anon (ex.: service_role)', () => {
  const service =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') +
    '.assinatura';
  assert.throws(() => toTemplate(`const K = '${service}'`), /não é anon/);
});

test('telas versionadas não têm domínio, projeto ou chave fixos', async () => {
  const files = (await readdir(PAGES_DIR)).filter((f) => f.endsWith('.html') && f !== 'pv.html');
  assert.ok(files.length >= 25);
  for (const file of files) {
    const html = await readFile(new URL(file, PAGES_DIR), 'utf8');
    assert.doesNotMatch(html, /victoreder\.com\.br|hxumiciyohbianfnzfyk|eyJhbGci/, file);
  }
});

test('render preenche todos os placeholders com stack + personalização', async () => {
  process.env.SUPABASE_ANON_KEY = 'anon-do-cliente';
  const replacements = buildReplacements({
    inboundConfig: {
      backUrl: 'https://painel.cliente.com/webhook',
      evolutionBaseUrl: 'https://evo.cliente.com',
    },
    personalizacao: {
      nome: 'Minha Marca',
      cor: 'FF0000',
      telefoneSuporte: '5511999999999',
      logoUrl: null,
      faviconUrl: 'https://cdn.cliente.com/fav.png',
      versao: 123,
    },
  });

  const html = await readFile(new URL('adminpannel.html', PAGES_DIR), 'utf8');
  const out = applyReplacements(html, replacements);
  assert.doesNotMatch(out, /__HUB_[A-Z_]+__/);
  assert.equal(replacements.__HUB_COR_RGB__, '255, 0, 0');
  assert.equal(replacements.__HUB_BACK_HOST__, 'painel.cliente.com');
  assert.equal(replacements.__HUB_FAVICON_URL__, 'https://cdn.cliente.com/fav.png?v=123');
  assert.match(replacements.__HUB_LOGO_URL__, /\/storage\/v1\/object\/public\/arquivos\/LOGO%20PRINCIPAL\.png\?v=123$/);
  assert.match(out, /value="Minha Marca"/);
});

test('sanitização da personalização', () => {
  assert.equal(normalizarCorHex('#25d366'), '25D366');
  assert.equal(normalizarCorHex('verde'), null);
  assert.equal(corParaRgb('25D366'), '37, 211, 102');
  assert.equal(sanitizarNome(`D'Ávila "Pro" <script>`), 'D’Ávila ”Pro” script');
  assert.equal(sanitizarTelefone('+55 (48) 98454-9300'), '5548984549300');
  assert.equal(sanitizarUrl("https://x.com/a.png'onerror=1"), null);
  assert.equal(sanitizarUrl('https://x.com/a.png'), 'https://x.com/a.png');
});

test('/token: mapeamento e mensagem padrão (port do n8n)', () => {
  const payload = { lead: { name: 'Ana', phones: ['', '5511988887777'] }, extra: { cidade: 'SP', vip: true } };
  const dados = mapearCamposLead(payload, {
    nome: '$.lead.name',
    telefone: ['lead.phones[0]', 'lead.phones[1]'],
    cp_6: 'extra.cidade',
    cp_7: 'extra.vip',
    cp_8: 'extra.naoExiste',
    _idEtiquetas: ['3', 7, 'x'],
  });

  assert.deepEqual(dados, {
    nome: 'Ana',
    telefone: '5511988887777',
    campos: [
      { idCampo: 6, valor: 'SP' },
      { idCampo: 7, valor: 'sim' },
    ],
    idEtiquetas: [3, 7],
  });
  assert.equal(
    montarMensagemLead('Oi [nome], de [ cp_6 ]? [campo_7] [desconhecido]!', dados),
    'Oi Ana, de SP? sim !',
  );
});

test('/integracao: mapeamento devolve todos os campos configurados', () => {
  const vars = mapearCamposPagamento(
    { buyer: { email: 'a@b.com', name: 'Ana' }, product: { name: 'Plano Pro' } },
    { email: 'buyer.email', nome: 'buyer.name', plano: 'product.name', telefone: 'buyer.phone' },
  );
  assert.deepEqual(vars, { email: 'a@b.com', nome: 'Ana', plano: 'Plano Pro', telefone: undefined });
});

test('/enviar-template: monta componentes como o n8n', () => {
  const payload = buildTemplatePayload({
    template: {
      nome: 'boas_vindas',
      idioma: 'pt_BR',
      componentes: {
        componentes: [
          { type: 'HEADER', format: 'IMAGE' },
          { type: 'BODY', text: 'Olá {{1}}, seu código é {{2}}' },
          { type: 'BUTTONS', buttons: [{ type: 'URL' }] },
        ],
        variaveisCampos: {
          body: { 1: 1, 2: 2 },
          header: { 1: 3 },
          buttons: [{ index: 0, fieldId: 2 }],
        },
      },
    },
    contato: { telefone: '+55 11 98888-7777', nome: 'Ana' },
    valoresCampos: [
      { idCampo: 2, valor: 'XYZ' },
      { idCampo: 3, valor: 'https://img/x.png' },
    ],
    camposPersonalizados: [{ id: 1, nome: 'Nome' }],
  });

  assert.equal(payload.to, '5511988887777');
  assert.deepEqual(payload.template.components, [
    { type: 'header', parameters: [{ type: 'image', image: { link: 'https://img/x.png' } }] },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Ana' },
        { type: 'text', text: 'XYZ' },
      ],
    },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'XYZ' }] },
  ]);
});

test('hojeMaisDias segue meia-noite de São Paulo (como $today.plus do n8n)', () => {
  // 02:00 UTC de 10/10 ainda é 09/10 em São Paulo.
  assert.equal(hojeMaisDias(2, new Date('2026-10-10T02:00:00Z')), '2026-10-11T00:00:00.000-03:00');
  assert.equal(hojeMaisDias(0, new Date('2026-10-10T15:00:00Z')), '2026-10-10T00:00:00.000-03:00');
});

const { buildAuthScript, injectAuthScript } = await import('../src/inbound/paginas/authScript.js');
const { AuthError, NIVEL, ROTAS_PROTEGIDAS, exigir, verificarNivel } = await import(
  '../src/inbound/auth/autenticar.js'
);
const { limitarTaxa } = await import('../src/inbound/auth/rateLimit.js');
const vm = await import('node:vm');

function rodarScriptNaTela({ backUrl, sessao }) {
  const chamadas = [];
  const storage = new Map([['sb-localhost-auth-token', JSON.stringify(sessao)]]);
  const window = {
    fetch: async (input, init = {}) => {
      chamadas.push({ url: String(input), headers: new Headers(init.headers) });
      return { status: 200 };
    },
  };
  const ctx = {
    window,
    location: { href: 'https://painel.cliente.com/webhook/configuracoes' },
    localStorage: { getItem: (k) => storage.get(k) ?? null },
    URL,
    Headers,
    Request,
    setTimeout,
  };
  const script = buildAuthScript(backUrl).replace(/^<script>|<\/script>$/g, '');
  vm.runInNewContext(script, ctx);
  return { fetch: window.fetch, chamadas };
}

test('script das telas anexa o token só nas rotas protegidas do próprio backend', async () => {
  const { fetch, chamadas } = rodarScriptNaTela({
    backUrl: 'https://painel.cliente.com/webhook',
    sessao: { access_token: 'jwt-do-usuario' },
  });

  await fetch('https://painel.cliente.com/webhook/uploadmedia', { method: 'POST' });
  await fetch('https://painel.cliente.com/webhook/sincronizar-supabase', {
    method: 'POST',
    headers: { Authorization: 'Bearer PAT' },
  });
  await fetch('https://painel.cliente.com/webhook/agente-no-whatsapp', { method: 'POST' });
  await fetch('https://outro.com/webhook/uploadmedia', { method: 'POST' });

  assert.equal(chamadas[0].headers.get('x-hub-session'), 'jwt-do-usuario');
  assert.equal(chamadas[1].headers.get('x-hub-session'), 'jwt-do-usuario');
  assert.equal(chamadas[1].headers.get('authorization'), 'Bearer PAT');
  assert.equal(chamadas[2].headers.get('x-hub-session'), null);
  assert.equal(chamadas[3].headers.get('x-hub-session'), null);
});

test('script é injetado logo após <head>', () => {
  const out = injectAuthScript('<html><head lang="pt"><script>x()</script></head></html>', '<script>A</script>');
  assert.equal(out, '<html><head lang="pt"><script>A</script><script>x()</script></head></html>');
});

test('níveis de acesso', async () => {
  const comum = { superAdmin: false, funcao: 'membro', contaId: 'c1' };
  const adminConta = { superAdmin: false, funcao: 'admin', contaId: 'c1' };
  const superAdmin = { superAdmin: true, funcao: null, contaId: null };

  await assert.rejects(verificarNivel(comum, NIVEL.SUPER_ADMIN), (e) => e instanceof AuthError && e.statusCode === 403);
  await assert.rejects(verificarNivel(adminConta, NIVEL.SUPER_ADMIN), /super admin/);
  await assert.rejects(verificarNivel(comum, NIVEL.ADMIN_CONTA), /administradores/);
  await verificarNivel(superAdmin, NIVEL.SUPER_ADMIN);
  await verificarNivel(superAdmin, NIVEL.LOGADO);

  assert.equal(ROTAS_PROTEGIDAS['/criar-usuario'], NIVEL.SUPER_ADMIN);
  assert.equal(ROTAS_PROTEGIDAS['/excluir-conta'], NIVEL.SUPER_ADMIN);
  assert.equal(ROTAS_PROTEGIDAS['/adicionar-usuario'], NIVEL.ADMIN_CONTA);
  assert.equal(ROTAS_PROTEGIDAS['/usuario-gratis'], undefined);
});

function respostaFake() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.set = (k, v) => ((res.headers[k] = v), res);
  return res;
}

test('exigir: sem sessão → 401; x-api-key correta vale como super admin', async () => {
  process.env.HUB_API_KEY = 'chave-integracao';
  const mw = exigir(NIVEL.SUPER_ADMIN);

  const semSessao = respostaFake();
  let passou = false;
  await mw({ headers: {}, path: '/criar-usuario' }, semSessao, () => (passou = true));
  assert.equal(passou, false);
  assert.equal(semSessao.statusCode, 401);

  const errada = respostaFake();
  await mw({ headers: { 'x-api-key': 'chave-errada' }, path: '/criar-usuario' }, errada, () => (passou = true));
  assert.equal(passou, false);
  assert.equal(errada.statusCode, 401);

  const req = { headers: { 'x-api-key': 'chave-integracao' }, path: '/criar-usuario' };
  await mw(req, respostaFake(), () => (passou = true));
  assert.equal(passou, true);
  assert.equal(req.usuario.superAdmin, true);
  delete process.env.HUB_API_KEY;
});

test('limite por IP bloqueia depois do máximo', () => {
  const mw = limitarTaxa({ nome: 'teste', max: 2, janelaMs: 60_000 });
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} };
  const resultados = [];
  for (let i = 0; i < 3; i += 1) {
    const res = respostaFake();
    let passou = false;
    mw(req, res, () => (passou = true));
    resultados.push(passou ? 'ok' : res.statusCode);
  }
  assert.deepEqual(resultados, ['ok', 'ok', 429]);
});

const { ipDoCliente, ipLiberado } = await import('../src/inbound/seguranca/ip.js');
const { PESO: PESO_JAIL, bloquearBanidos, detectarVarredura, registrarInfracao } = await import(
  '../src/inbound/seguranca/jail.js'
);
const { login } = await import('../src/inbound/seguranca/login.js');
const { limitarConcorrencia } = await import('../src/inbound/seguranca/sobrecarga.js');
const { criarFiltroEssencial } = await import('../src/inbound/seguranca/middlewares.js');
const { EventEmitter } = await import('node:events');

test('IP do cliente: último hop do X-Forwarded-For; rede interna nunca é limitada', () => {
  assert.equal(ipDoCliente({ headers: { 'x-forwarded-for': '6.6.6.6, 200.1.2.3' }, socket: {} }), '200.1.2.3');
  assert.equal(ipDoCliente({ headers: {}, socket: { remoteAddress: '::ffff:8.8.8.8' } }), '8.8.8.8');
  assert.equal(ipLiberado('10.0.1.5'), true);
  assert.equal(ipLiberado('172.20.0.3'), true);
  assert.equal(ipLiberado('200.1.2.3'), false);
});

test('jail: soma pontos e bane o IP ao passar do limite', async () => {
  const ip = '203.0.113.7';
  for (let i = 0; i < 2; i += 1) await registrarInfracao(ip, PESO_JAIL.VARREDURA, 'teste');
  const res = respostaFake();
  let passou = false;
  await bloquearBanidos()({ headers: { 'x-forwarded-for': ip }, socket: {} }, res, () => (passou = true));
  assert.equal(passou, false);
  assert.equal(res.statusCode, 403);

  const livre = respostaFake();
  await bloquearBanidos()({ headers: { 'x-forwarded-for': '203.0.113.8' }, socket: {} }, livre, () => (passou = true));
  assert.equal(passou, true);
});

test('varredura de robôs é barrada', () => {
  const mw = detectarVarredura();
  for (const path of ['/.env', '/wp-login.php', '/.git/config', '/vendor/phpunit/x']) {
    const res = respostaFake();
    res.end = () => res;
    let passou = false;
    mw({ path, headers: { 'x-forwarded-for': '198.51.100.1' }, socket: {} }, res, () => (passou = true));
    assert.equal(passou, false, path);
    assert.equal(res.statusCode, 404);
  }
  let passou = false;
  mw({ path: '/login', headers: {}, socket: {} }, respostaFake(), () => (passou = true));
  assert.equal(passou, true);
});

test('login: 5 senhas erradas bloqueiam o e-mail; sucesso devolve a sessão', async () => {
  const fetchOriginal = globalThis.fetch;
  let senhaCerta = false;
  globalThis.fetch = async () => ({
    status: senhaCerta ? 200 : 400,
    json: async () =>
      senhaCerta
        ? { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }
        : { error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
  });

  const req = (email) => ({ body: { email, password: 'x' }, headers: { 'x-forwarded-for': '192.0.2.50' }, socket: {} });
  try {
    for (let i = 1; i <= 4; i += 1) {
      await assert.rejects(login(req('vitima@ex.com')), (e) => e.statusCode === 401 && e.message.includes(`${5 - i} tentativa`));
    }
    await assert.rejects(login(req('vitima@ex.com')), (e) => e.statusCode === 429);
    senhaCerta = true;
    await assert.rejects(login(req('vitima@ex.com')), (e) => e.statusCode === 429 && /Tente novamente/.test(e.message));

    const ok = await login(req('outro@ex.com'));
    assert.equal(ok.session.access_token, 'at');
    assert.equal(ok.session.refresh_token, 'rt');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('concorrência: excedente vai para fila e, com fila cheia, recebe 503', () => {
  const mw = limitarConcorrencia({ nome: 't', max: 1, fila: 1 });
  const novo = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.status = (code) => ((res.statusCode = code), res);
    res.json = () => res;
    res.set = () => res;
    return { req: new EventEmitter(), res };
  };
  const a = novo();
  const b = novo();
  const c = novo();
  const iniciados = [];
  mw(a.req, a.res, () => iniciados.push('a'));
  mw(b.req, b.res, () => iniciados.push('b'));
  mw(c.req, c.res, () => iniciados.push('c'));
  assert.deepEqual(iniciados, ['a']);
  assert.equal(c.res.statusCode, 503);
  a.res.emit('finish');
  assert.deepEqual(iniciados, ['a', 'b']);
});

test('webhooks da Meta/Evolution ficam fora do limite global', () => {
  const essencial = criarFiltroEssencial({
    eventsMetaPath: '/eventsmeta',
    evolutionWebhookPath: '/agente-no-whatsapp',
    evolutionWebhookLegacyPath: '/webhook-mensagens',
    metaApiPaths: { token: '/meta-token' },
  });
  assert.equal(essencial({ path: '/eventsmeta' }), true);
  assert.equal(essencial({ path: '/agente-no-whatsapp/inserir-conhecimento' }), true);
  assert.equal(essencial({ path: '/token' }), true);
  assert.equal(essencial({ path: '/login' }), false);
  assert.equal(essencial({ path: '/uploadmedia' }), false);
});
