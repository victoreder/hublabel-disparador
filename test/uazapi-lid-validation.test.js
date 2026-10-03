import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLidJid } from '../src/evolution/lid.js';
import { createUazapiClient } from '../src/uazapi/client.js';

test('normalizeLidJid descarta o sufixo de device', () => {
  assert.equal(normalizeLidJid('114903327215726:11@lid'), '114903327215726@lid');
  assert.equal(normalizeLidJid('114903327215726@lid'), '114903327215726@lid');
  assert.equal(normalizeLidJid('5511947870864@s.whatsapp.net'), null);
});

test('checkWhatsAppNumbers da UazAPI mantém o @lid no /chat/check', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify([
        {
          query: '114903327215726@lid',
          isInWhatsapp: true,
          jid: '5511947870864@s.whatsapp.net',
          lid: '114903327215726@lid',
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createUazapiClient({ baseUrl: 'https://uaz.test', instanceToken: 't' });
    const results = await client.checkWhatsAppNumbers(null, ['114903327215726:11@lid']);
    assert.deepEqual(calls[0].body.numbers, ['114903327215726@lid']);
    assert.equal(results[0].exists, true);
    assert.equal(results[0].jid, '5511947870864@s.whatsapp.net');
    assert.equal(results[0].lid, '114903327215726@lid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
