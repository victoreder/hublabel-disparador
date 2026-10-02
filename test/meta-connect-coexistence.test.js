import test from 'node:test';
import assert from 'node:assert/strict';

// connect.js importa supabase.js/config.js, que exigem estas variaveis; valores ficticios bastam aqui.
async function importConnect() {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
  process.env.SUPABASE_URL ??= 'http://localhost';
  return import('../src/inbound/meta/connect.js');
}

test('numero no app Business e coexistencia, mesmo sem dica do front', async () => {
  const { decidePhoneAction } = await importConnect();
  assert.equal(decidePhoneAction({ is_on_biz_app: true, status: 'PENDING' }), 'coexistence');
});

test('numero novo verificado vai para register mesmo com front dizendo coexistencia', async () => {
  const { decidePhoneAction, normalizeFlowType } = await importConnect();
  const entrada = normalizeFlowType({ flowType: 'coexistence' });
  assert.equal(entrada.embeddedSignupEvent, null);
  const phone = { is_on_biz_app: false, status: 'PENDING', code_verification_status: 'VERIFIED' };
  assert.equal(decidePhoneAction(phone, { metaCoexistenceEvent: false, attempt: 1 }), 'ready');
});

test('evento de coexistencia da Meta espera o is_on_biz_app antes de registrar', async () => {
  const { decidePhoneAction } = await importConnect();
  const phone = { is_on_biz_app: false, status: 'PENDING', code_verification_status: 'VERIFIED' };
  assert.equal(decidePhoneAction(phone, { metaCoexistenceEvent: true, attempt: 1 }), 'wait');
  assert.equal(decidePhoneAction(phone, { metaCoexistenceEvent: true, attempt: 6 }), 'ready');
  assert.equal(
    decidePhoneAction({ ...phone, is_on_biz_app: true }, { metaCoexistenceEvent: true, attempt: 2 }),
    'coexistence',
  );
});

test('numero ainda nao verificado aguarda', async () => {
  const { decidePhoneAction } = await importConnect();
  assert.equal(decidePhoneAction({ status: 'PENDING', code_verification_status: 'NOT_VERIFIED' }), 'wait');
});

test('evento da Meta e repassado sem ser inventado a partir do flowType', async () => {
  const { normalizeFlowType } = await importConnect();
  assert.deepEqual(normalizeFlowType({ embeddedSignupEvent: 'FINISH' }), {
    flowType: 'auto',
    embeddedSignupEvent: 'FINISH',
  });
  assert.deepEqual(normalizeFlowType({ session: { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' } }), {
    flowType: 'auto',
    embeddedSignupEvent: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  });
});
