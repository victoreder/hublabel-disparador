import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPhoneCandidatesForValidatedContact,
  resolveBrazilPhoneForMeta,
} from '../src/phone.js';
import {
  EvolutionError,
  classifyEvolutionError,
  isRetryableEvolutionKind,
} from '../src/evolution/client.js';
import { getValidationNumberCandidates, phonesMatch } from '../src/evolution/phoneVariants.js';
import {
  UazapiError,
  classifyUazapiError,
  isRetryableUazapiKind,
} from '../src/uazapi/client.js';

test('preserva o 9 de celulares DDD 11 iniciados por 92 a 95', () => {
  for (const phone of ['5511921234567', '5511931234567', '5511947870864', '5511951234567']) {
    assert.deepEqual(resolveBrazilPhoneForMeta(phone), {
      phone,
      action: 'celular-13',
    });
    assert.deepEqual(getValidationNumberCandidates(phone), [phone]);
  }
});

test('não considera celular 94 equivalente a um fixo 4', () => {
  assert.equal(phonesMatch('5511947870864', '551147870864'), false);
});

test('contato validado não ganha, perde ou alterna o nono dígito', () => {
  assert.deepEqual(getPhoneCandidatesForValidatedContact('5511947870864@s.whatsapp.net'), {
    candidates: ['5511947870864'],
    resolution: {
      phone: '5511947870864',
      action: 'validated-unchanged',
      original: '5511947870864',
    },
  });
  assert.deepEqual(getPhoneCandidatesForValidatedContact('551147870864'), {
    candidates: ['551147870864'],
    resolution: {
      phone: '551147870864',
      action: 'validated-unchanged',
      original: '551147870864',
    },
  });
});

test('UazAPI classifica not on WhatsApp antes do HTTP 500', () => {
  const error = new UazapiError(500, 'Internal Server Error', {
    response: { message: 'the number 5511947870864 is not on WhatsApp' },
  });
  const kind = classifyUazapiError(error);
  assert.equal(kind, 'invalidRecipient');
  assert.equal(isRetryableUazapiKind(kind), false);
});

test('Evolution classifica not on WhatsApp antes do HTTP 500', () => {
  const error = new EvolutionError(500, 'Internal Server Error', {
    response: { message: ['The number is not on WhatsApp'] },
  });
  const kind = classifyEvolutionError(error);
  assert.equal(kind, 'invalidRecipient');
  assert.equal(isRetryableEvolutionKind(kind), false);
});

test('UazAPI reconhece sessão WhatsApp não reconectável como desconectada', () => {
  const error = new UazapiError(
    503,
    'WhatsApp disconnected: session is not reconnectable',
    null,
  );
  const kind = classifyUazapiError(error);
  assert.equal(kind, 'disconnected');
  assert.equal(isRetryableUazapiKind(kind), false);
});

test('Evolution reconhece sessão WhatsApp não reconectável como desconectada', () => {
  const error = new EvolutionError(
    503,
    'WhatsApp disconnected: session is not reconnectable',
    null,
  );
  const kind = classifyEvolutionError(error);
  assert.equal(kind, 'disconnected');
  assert.equal(isRetryableEvolutionKind(kind), false);
});

// src/meta.js importa src/config.js, que exige estas variaveis; valores ficticios bastam aqui.
async function importMeta() {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
  process.env.SUPABASE_URL ??= 'http://localhost';
  return import('../src/meta.js');
}

test('Meta 133010 (numero remetente nao registrado) nao vira contato inexistente', async () => {
  const { MetaApiError, isRecipientPhoneError, isSenderNotRegisteredError } = await importMeta();
  const error = new MetaApiError('Account not registered', {
    status: 400,
    body: { error: { code: 133010, message: 'Account not registered' } },
  });
  assert.equal(isSenderNotRegisteredError(error), true);
  assert.equal(isRecipientPhoneError(error), false);
});

test('Meta 131026 continua sendo erro de destinatario', async () => {
  const { MetaApiError, isRecipientPhoneError, isSenderNotRegisteredError } = await importMeta();
  const error = new MetaApiError('Message undeliverable', {
    status: 400,
    body: { error: { code: 131026, message: 'Message undeliverable' } },
  });
  assert.equal(isSenderNotRegisteredError(error), false);
  assert.equal(isRecipientPhoneError(error), true);
});
