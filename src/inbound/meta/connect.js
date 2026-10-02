import {
  createConexaoApiOficial,
  fetchConfigApiOficial,
  updateConexaoApiOficial,
} from '../../supabase.js';
import { logger } from '../../logger.js';
import { exchangeCodeForToken, exchangeLongLivedToken, metaGet, metaPost } from './graph.js';
import { HttpError } from './httpError.js';

const EMBEDDED_SIGNUP_EVENT_COEXISTENCE = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
const PHONE_STATE_FIELDS =
  'status,code_verification_status,is_on_biz_app,platform_type,display_phone_number,verified_name';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;
const REGISTER_RETRY_DELAY_MS = 3000;
const REGISTER_MAX_ATTEMPTS = 3;
// Quando a Meta devolve o evento de coexistencia, espera um pouco o is_on_biz_app propagar
// antes de concluir que o numero nao esta no app Business (e registrar).
const COEX_WAIT_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// embeddedSignupEvent e o `event` que a Meta devolve no postMessage WA_EMBEDDED_SIGNUP
// (FINISH = numero novo, FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING = coexistencia) e e repassado
// como veio. flowType e so uma dica do front: no Embedded Signup v4 o cliente escolhe numero novo
// ou numero do app Business dentro do proprio fluxo, entao o front nao sabe de antemao.
export function normalizeFlowType(body) {
  const embeddedSignupEvent =
    body?.embeddedSignupEvent ||
    body?.embedded_signup_event ||
    body?.session?.embeddedSignupEvent ||
    body?.session?.event ||
    null;

  const flowTypeRaw = body?.flowType || body?.flow_type || null;

  if (flowTypeRaw === 'coexistence' || flowTypeRaw === 'whatsapp_business_app_onboarding') {
    return { flowType: 'coexistence', embeddedSignupEvent };
  }

  if (flowTypeRaw === 'standard' || flowTypeRaw === 'new_number') {
    return { flowType: flowTypeRaw, embeddedSignupEvent };
  }

  return { flowType: 'auto', embeddedSignupEvent };
}

function parseConnectBody(body) {
  logger.info('[meta-token] parse body', {
    temBody: body != null,
    tipoBody: typeof body,
    keys: body && typeof body === 'object' ? Object.keys(body) : [],
  });

  const code = body?.code;
  const wabaId = body?.waba_id || null;
  const phoneNumberId = body?.phone_number_id || null;
  const businessId = body?.business_id || null;
  const conexaoId = body?.conexaoId || body?.conexao_id || null;
  const contaId = body?.contaId || body?.conta_id || null;
  const nome = body?.NomeConexao || body?.nome || 'WhatsApp API Oficial';
  const { flowType, embeddedSignupEvent } = normalizeFlowType(body);

  if (!code || typeof code !== 'string') {
    logger.warn('[meta-token] validacao falhou', { motivo: 'code ausente ou invalido', conexaoId, contaId });
    throw new HttpError('Campo code obrigatorio.');
  }
  if (!conexaoId && !contaId) {
    logger.warn('[meta-token] validacao falhou', { motivo: 'conexaoId e contaId ausentes' });
    throw new HttpError('Informe conexaoId (atualizar) ou contaId (criar nova conexao).');
  }

  return {
    code,
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    business_id: businessId,
    conexaoId,
    contaId,
    NomeConexao: nome,
    flowType,
    embeddedSignupEvent,
  };
}

function isCoexistencePhone(phoneRes) {
  // Meta: coexistencia = is_on_biz_app true + platform_type CLOUD_API (nao muda o platform_type).
  return phoneRes?.is_on_biz_app === true;
}

function isMetaCoexistenceEvent({ embeddedSignupEvent }) {
  return embeddedSignupEvent === EMBEDDED_SIGNUP_EVENT_COEXISTENCE;
}

function isFrontCoexistenceHint({ flowType, embeddedSignupEvent }) {
  return flowType === 'coexistence' || isMetaCoexistenceEvent({ embeddedSignupEvent });
}

/**
 * Decide, a cada leitura do numero na Meta, o que fazer:
 * - 'coexistence': numero esta no app WhatsApp Business (is_on_biz_app) -> nao registrar.
 * - 'ready': numero novo verificado/conectado -> seguir para o /register (ou pular se CONNECTED).
 * - 'wait': ainda propagando.
 * A coexistencia vem do estado real do numero, nunca so do que o front diz; o evento de
 * coexistencia da Meta apenas segura o register por alguns ciclos esperando o is_on_biz_app.
 */
export function decidePhoneAction(phone, { metaCoexistenceEvent = false, attempt = 1 } = {}) {
  if (isCoexistencePhone(phone)) return 'coexistence';
  if (metaCoexistenceEvent && attempt <= COEX_WAIT_ATTEMPTS) return 'wait';
  if (phone?.status === 'CONNECTED') return 'ready';
  if (phone?.code_verification_status === 'VERIFIED') return 'ready';
  return 'wait';
}

async function fetchPhoneState(version, phoneNumberId, accessToken) {
  return metaGet({
    version,
    path: phoneNumberId,
    accessToken,
    query: { fields: PHONE_STATE_FIELDS },
  });
}

async function fetchBusinessAssets(version, accessToken) {
  const businessRes = await metaGet({
    version,
    path: 'me/businesses',
    accessToken,
    query: { fields: 'id,name' },
  });

  const businessId = businessRes.data?.[0]?.id;
  if (!businessId) throw new HttpError('Nenhuma conta Business encontrada.');

  const wabaRes = await metaGet({
    version,
    path: `${businessId}/owned_whatsapp_business_accounts`,
    accessToken,
    query: { fields: 'id,name' },
  });

  const wabaId = wabaRes.data?.[0]?.id;
  if (!wabaId) throw new HttpError('Nenhuma WABA encontrada.');

  const phoneRes = await metaGet({
    version,
    path: `${wabaId}/phone_numbers`,
    accessToken,
    query: { fields: 'id,display_phone_number,verified_name' },
  });

  const phone = phoneRes.data?.[0];
  if (!phone?.id) throw new HttpError('Nenhum phone_number_id encontrado.');

  return {
    business_id: businessId,
    waba_id: wabaId,
    phone_number_id: phone.id,
    Telefone: phone.display_phone_number ? String(phone.display_phone_number).replace(/\D/g, '') : null,
    verified_name: phone.verified_name || null,
  };
}

async function subscribeWaba(version, wabaId, accessToken) {
  const res = await metaPost({ version, path: `${wabaId}/subscribed_apps`, accessToken, body: {} });
  if (res.success !== true) {
    throw new HttpError('subscribed_apps nao retornou success:true.');
  }
  return res;
}

// A coexistencia e decidida pelo estado real do numero na Meta (is_on_biz_app), nao pelo
// flowType enviado pelo front: o front sinalizava coexistencia para numeros novos, o /register
// era pulado e o numero ficava PENDING na Meta.
async function waitForPhoneReady(
  version,
  phoneNumberId,
  accessToken,
  { initialPhone = null, metaCoexistenceEvent = false },
) {
  let phone = initialPhone;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    if (!phone || attempt > 1) {
      phone = await fetchPhoneState(version, phoneNumberId, accessToken);
    }

    const acao = decidePhoneAction(phone, { metaCoexistenceEvent, attempt });

    if (acao !== 'wait') {
      return { phone, coexistence: acao === 'coexistence', attempts: attempt };
    }

    if (attempt < POLL_MAX_ATTEMPTS) {
      logger.info('[meta-token] aguardando meta propagar numero', {
        phone_number_id: phoneNumberId,
        attempt,
        status: phone.status || null,
        code_verification_status: phone.code_verification_status || null,
        is_on_biz_app: phone.is_on_biz_app ?? null,
        platform_type: phone.platform_type || null,
      });
      await sleep(POLL_INTERVAL_MS);
    }
  }

  return {
    phone,
    coexistence: isCoexistencePhone(phone),
    attempts: POLL_MAX_ATTEMPTS,
    timedOut: true,
  };
}

async function registerPhoneIfNeeded(version, phoneNumberId, accessToken, options = {}) {
  const frontCoexistenceHint = isFrontCoexistenceHint(options);
  const { phone, coexistence, attempts, timedOut } = await waitForPhoneReady(
    version,
    phoneNumberId,
    accessToken,
    {
      initialPhone: options.initialPhone || null,
      metaCoexistenceEvent: isMetaCoexistenceEvent(options),
    },
  );

  if (frontCoexistenceHint && !coexistence) {
    logger.warn('[meta-token] front sinalizou coexistencia mas o numero nao esta no app Business; tratando como numero novo', {
      phone_number_id: phoneNumberId,
      embeddedSignupEvent: options.embeddedSignupEvent || null,
      flowType: options.flowType || null,
      status: phone.status || null,
      code_verification_status: phone.code_verification_status || null,
      is_on_biz_app: phone.is_on_biz_app ?? null,
      platform_type: phone.platform_type || null,
    });
  }

  const statusAntes = phone.status || null;
  let pin = null;
  let registrado = false;
  let statusDepois = statusAntes;
  let pulouRegister = false;

  if (coexistence) {
    pulouRegister = true;
    logger.info('[meta-token] coexistencia: pulando register', {
      phone_number_id: phoneNumberId,
      embeddedSignupEvent: options.embeddedSignupEvent || null,
      flowType: options.flowType || null,
      status: statusAntes,
      is_on_biz_app: phone.is_on_biz_app ?? null,
      platform_type: phone.platform_type || null,
      attempts,
    });

    return {
      phone_number_id: phoneNumberId,
      pin,
      registrado,
      status_antes: statusAntes,
      status_depois: statusDepois,
      coexistencia: true,
      pulou_register: true,
      code_verification_status: phone.code_verification_status || null,
      is_on_biz_app: phone.is_on_biz_app ?? null,
      platform_type: phone.platform_type || null,
    };
  }

  if (statusAntes === 'CONNECTED') {
    pulouRegister = true;
    return {
      phone_number_id: phoneNumberId,
      pin,
      registrado,
      status_antes: statusAntes,
      status_depois: statusDepois,
      coexistencia: false,
      pulou_register: true,
      code_verification_status: phone.code_verification_status || null,
      is_on_biz_app: phone.is_on_biz_app ?? null,
      platform_type: phone.platform_type || null,
    };
  }

  if (phone.code_verification_status !== 'VERIFIED') {
    if (timedOut) {
      throw new HttpError(
        'A Meta ainda nao concluiu a verificacao do numero. Aguarde cerca de 1 minuto e tente conectar novamente.',
        400,
      );
    }
  }

  pin = String(Math.floor(100000 + Math.random() * 900000));

  for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS; attempt++) {
    try {
      await metaPost({
        version,
        path: `${phoneNumberId}/register`,
        accessToken,
        body: { messaging_product: 'whatsapp', pin },
      });
      registrado = true;
      statusDepois = 'CONNECTED';
      break;
    } catch (error) {
      if (error instanceof HttpError && error.message.includes('133005')) {
        throw new HttpError(
          'PIN de verificacao em duas etapas incorreto. O numero ja possui 2FA; informe o PIN existente.',
        );
      }

      const isReverification =
        error instanceof HttpError &&
        (error.message.includes('133006') || error.message.includes('re-verification'));

      if (isReverification && attempt < REGISTER_MAX_ATTEMPTS) {
        logger.info('[meta-token] register aguardando reverificacao meta', {
          phone_number_id: phoneNumberId,
          attempt,
        });
        await sleep(REGISTER_RETRY_DELAY_MS);
        continue;
      }

      if (isReverification) {
        throw new HttpError(
          'A Meta ainda nao concluiu a verificacao do numero. Aguarde cerca de 1 minuto e tente conectar novamente.',
          400,
        );
      }

      throw error;
    }
  }

  return {
    phone_number_id: phoneNumberId,
    pin,
    registrado,
    status_antes: statusAntes,
    status_depois: statusDepois,
    coexistencia: false,
    pulou_register: pulouRegister,
    code_verification_status: phone.code_verification_status || null,
    is_on_biz_app: phone.is_on_biz_app ?? null,
    platform_type: phone.platform_type || null,
  };
}

export async function handleConnectMeta(body, { metaGraphApiVersion }) {
  const entrada = parseConnectBody(body);

  logger.info('[meta-token] inicio', {
    conexaoId: entrada.conexaoId,
    contaId: entrada.contaId,
    waba_id: entrada.waba_id,
    phone_number_id: entrada.phone_number_id,
    business_id: entrada.business_id,
    modo: entrada.conexaoId ? 'atualizar' : 'criar',
    temCode: Boolean(entrada.code),
    flowType: entrada.flowType,
    embeddedSignupEvent: entrada.embeddedSignupEvent,
  });

  const config = await fetchConfigApiOficial('app_id, app_secret');

  if (!config?.app_id || !config?.app_secret) {
    throw new HttpError('Config API Oficial incompleta em SAAS_Config_ApiOficial.');
  }

  logger.info('[meta-token] trocando code por token curto', { appId: config.app_id });
  const curto = await exchangeCodeForToken({
    version: metaGraphApiVersion,
    appId: config.app_id,
    appSecret: config.app_secret,
    code: entrada.code,
  });

  logger.info('[meta-token] token curto obtido', {
    tokenType: curto.token_type || null,
    expiresIn: curto.expires_in ?? null,
  });

  const longo = await exchangeLongLivedToken({
    version: metaGraphApiVersion,
    appId: config.app_id,
    appSecret: config.app_secret,
    shortLivedToken: curto.access_token,
  });

  const accessToken = longo.access_token;
  const expiresIn = longo.expires_in || null;
  const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null;

  logger.info('[meta-token] token longo obtido', { expiresIn, expiresAt });

  let business_id = entrada.business_id;
  let waba_id = entrada.waba_id;
  let phone_number_id = entrada.phone_number_id;
  let Telefone = null;
  let verified_name = null;
  let initialPhone = null;

  const temIdsFront = !!waba_id && !!phone_number_id;

  if (temIdsFront) {
    logger.info('[meta-token] buscando telefone pelos IDs do front', { phone_number_id });
    initialPhone = await fetchPhoneState(metaGraphApiVersion, phone_number_id, accessToken);
    Telefone = initialPhone.display_phone_number
      ? String(initialPhone.display_phone_number).replace(/\D/g, '')
      : null;
    verified_name = initialPhone.verified_name || null;
    if (!Telefone) throw new HttpError('Meta nao retornou display_phone_number para o phone_number_id.');
  } else {
    logger.info('[meta-token] buscando assets Business/WABA/telefone na Meta');
    const assets = await fetchBusinessAssets(metaGraphApiVersion, accessToken);
    business_id = assets.business_id;
    waba_id = assets.waba_id;
    phone_number_id = assets.phone_number_id;
    Telefone = assets.Telefone;
    verified_name = assets.verified_name;
    if (!Telefone) throw new HttpError('Meta nao retornou display_phone_number.');
  }

  logger.info('[meta-token] assets resolvidos', {
    business_id,
    waba_id,
    phone_number_id,
    Telefone,
    verified_name,
    flowType: entrada.flowType,
    embeddedSignupEvent: entrada.embeddedSignupEvent,
  });

  logger.info('[meta-token] subscribed_apps', { waba_id });
  await subscribeWaba(metaGraphApiVersion, waba_id, accessToken);

  const registro = await registerPhoneIfNeeded(metaGraphApiVersion, phone_number_id, accessToken, {
    flowType: entrada.flowType,
    embeddedSignupEvent: entrada.embeddedSignupEvent,
    initialPhone,
  });

  logger.info('[meta-token] registro numero', {
    phone_number_id,
    registrado: registro.registrado,
    status_antes: registro.status_antes,
    status_depois: registro.status_depois,
    pinGerado: Boolean(registro.pin),
    coexistencia: registro.coexistencia === true,
    pulou_register: registro.pulou_register === true,
    code_verification_status: registro.code_verification_status,
    is_on_biz_app: registro.is_on_biz_app,
    platform_type: registro.platform_type,
  });

  const nomeConexao =
    entrada.NomeConexao && entrada.NomeConexao !== 'WhatsApp API Oficial'
      ? entrada.NomeConexao
      : verified_name || entrada.NomeConexao;

  const dbPayload = {
    apiOficial: true,
    NomeConexao: nomeConexao,
    access_token: accessToken,
    expires_in: expiresIn,
    business_id,
    waba_id,
    phone_number_id,
    Telefone,
    expires_at: expiresAt,
    metaPhoneStatus: registro.status_depois || null,
    ...(registro.pin ? { metaPinVerificacao: registro.pin } : {}),
  };

  const row = entrada.conexaoId
    ? await updateConexaoApiOficial(entrada.conexaoId, dbPayload)
    : await createConexaoApiOficial({ ...dbPayload, contaId: entrada.contaId });

  if (!row?.id) throw new HttpError('Falha ao salvar conexao em SAAS_Conexoes.', 500);

  logger.info('[meta-token] conexao salva', {
    conexaoId: row.id,
    contaId: row.contaId,
    NomeConexao: row.NomeConexao,
    phone_number_id: row.phone_number_id,
    waba_id: row.waba_id,
    expires_at: expiresAt,
    metaPhoneStatus: row.metaPhoneStatus || registro.status_depois || null,
    coexistencia: registro.coexistencia === true,
  });

  const resposta = {
    ok: true,
    conexaoId: row.id,
    contaId: row.contaId,
    NomeConexao: row.NomeConexao,
    business_id: row.business_id,
    waba_id: row.waba_id,
    phone_number_id: row.phone_number_id,
    Telefone: row.Telefone,
    expires_in: row.expires_in,
    apiOficial: row.apiOficial,
    metaPhoneStatus: row.metaPhoneStatus || registro.status_depois || null,
    numero_registrado: registro.registrado === true,
    coexistencia: registro.coexistencia === true,
    pulou_register: registro.pulou_register === true,
    flowType: entrada.flowType,
    embeddedSignupEvent: entrada.embeddedSignupEvent || null,
  };

  if (registro.pin) {
    resposta.metaPinVerificacao = registro.pin;
    resposta.aviso_pin = 'Guarde este PIN de 6 digitos. Ele e a verificacao em duas etapas do numero na Meta.';
  }

  return resposta;
}
