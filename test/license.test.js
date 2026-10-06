import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  computeFingerprint,
  isLicenseEnforced,
  normalizeInstallationHost,
  verifySignedLicense,
} from '../src/license.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

function signed(payload, key = privateKey) {
  const data = Buffer.from(JSON.stringify(payload));
  return { payload: data.toString('base64'), assinatura: sign(null, data, key).toString('base64') };
}

const fingerprint = computeFingerprint('https://abcd.supabase.co/');
const future = new Date(Date.now() + 3600_000).toISOString();

test('rodando do código-fonte a licença não é exigida', () => {
  assert.equal(isLicenseEnforced(), false);
});

test('fingerprint depende só do host do Supabase', () => {
  assert.equal(normalizeInstallationHost('https://ABCD.supabase.co/rest/v1'), 'abcd.supabase.co');
  assert.equal(computeFingerprint('https://abcd.supabase.co'), fingerprint);
  assert.notEqual(computeFingerprint('https://outro.supabase.co'), fingerprint);
});

test('aceita resposta assinada válida', () => {
  const res = signed({ ok: true, fingerprint, nonce: 'n1', validoAte: future, cliente: 'X' });
  const payload = verifySignedLicense(res, { publicKeyPem, fingerprint, nonce: 'n1' });
  assert.equal(payload.cliente, 'X');
});

test('recusa assinatura de outra chave (servidor falso)', () => {
  const fake = generateKeyPairSync('ed25519').privateKey;
  const res = signed({ ok: true, fingerprint, nonce: 'n1', validoAte: future }, fake);
  assert.throws(() => verifySignedLicense(res, { publicKeyPem, fingerprint, nonce: 'n1' }), /Assinatura/);
});

test('recusa payload adulterado', () => {
  const res = signed({ ok: false, fingerprint, nonce: 'n1', validoAte: future });
  const tampered = Buffer.from(JSON.stringify({ ok: true, fingerprint, nonce: 'n1', validoAte: future }));
  res.payload = tampered.toString('base64');
  assert.throws(() => verifySignedLicense(res, { publicKeyPem, fingerprint, nonce: 'n1' }), /Assinatura/);
});

test('recusa licença de outra instalação, nonce reaproveitado e validade vencida', () => {
  const other = signed({ ok: true, fingerprint: computeFingerprint('x.supabase.co'), nonce: 'n1', validoAte: future });
  assert.throws(() => verifySignedLicense(other, { publicKeyPem, fingerprint, nonce: 'n1' }), /outra instalação/);

  const replay = signed({ ok: true, fingerprint, nonce: 'antigo', validoAte: future });
  assert.throws(() => verifySignedLicense(replay, { publicKeyPem, fingerprint, nonce: 'n1' }), /nonce/);

  const expired = signed({ ok: true, fingerprint, nonce: 'n1', validoAte: new Date(Date.now() - 1000).toISOString() });
  assert.throws(() => verifySignedLicense(expired, { publicKeyPem, fingerprint, nonce: 'n1' }), /expirada/);
});
