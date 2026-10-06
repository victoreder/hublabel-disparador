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
