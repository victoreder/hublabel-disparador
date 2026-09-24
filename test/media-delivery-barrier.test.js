import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveMediaSettleDelayMs,
  waitForMediaSettlement,
} from '../src/inbound/agent/mediaDeliveryBarrier.js';

test('usa uma pequena barreira padrão depois de mídia', async () => {
  const waits = [];
  const delay = await waitForMediaSettlement('image', {}, async (ms) => waits.push(ms));

  assert.equal(delay, 1500);
  assert.deepEqual(waits, [1500]);
});

test('texto não espera a barreira de mídia', async () => {
  const waits = [];
  const delay = await waitForMediaSettlement('text', {}, async (ms) => waits.push(ms));

  assert.equal(delay, 0);
  assert.deepEqual(waits, []);
});

test('permite configurar ou desativar a espera e limita valores excessivos', () => {
  assert.equal(resolveMediaSettleDelayMs({ mediaSettleDelayMs: 800 }), 800);
  assert.equal(resolveMediaSettleDelayMs({ mediaSettleDelayMs: 0 }), 0);
  assert.equal(resolveMediaSettleDelayMs({ mediaSettleDelayMs: 50_000 }), 10_000);
  assert.equal(resolveMediaSettleDelayMs({ mediaSettleDelayMs: -1 }), 0);
});
