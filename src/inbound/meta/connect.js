import {
  createConexaoApiOficial,
  fetchConfigApiOficial,
  updateConexaoApiOficial,
} from '../../supabase.js';
import { logger } from '../../logger.js';
import { exchangeCodeForToken, exchangeLongLivedToken, metaGet, metaPost } from './graph.js';
import { HttpError } from './httpError.js';
import { getInboundConfig } from '../config.js';

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

  if (!code || typeof code !== 'string') {
    logger.warn('[meta-token] validacao falhou', { motivo: 'code ausente ou invalido', conexaoId, contaId });
    throw new HttpError('Campo code obrigatorio.');
  }
  if (!conexaoId && !contaId) {
    logger.warn('[meta-token] validacao falhou', { motivo: 'conexaoId e contaId ausentes' });
    throw new HttpError('Informe conexaoId (atualizar) ou contaId (criar nova conexao).');
  }

  return { code, waba_id: wabaId, phone_number_id: phoneNumberId, business_id: businessId, conexaoId, contaId, NomeConexao: nome };
}

async function fetchPhoneDetails(version, phoneNumberId, accessToken) {
  return metaGet({
    version,
    path: phoneNumberId,
    accessToken,
    query: { fields: 'display_phone_number,verified_name' },
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

async function registerPhoneIfNeeded(version, phoneNumberId, accessToken) {
  const phoneRes = await metaGet({
    version,
    path: phoneNumberId,
    accessToken,
    query: { fields: 'status' },
  });

  const statusAntes = phoneRes.status || null;
  let pin = null;
  let registrado = false;
  let statusDepois = statusAntes;

  if (statusAntes !== 'CONNECTED') {
    pin = String(Math.floor(100000 + Math.random() * 900000));

    try {
      await metaPost({
        version,
        path: `${phoneNumberId}/register`,
        accessToken,
        body: { messaging_product: 'whatsapp', pin },
      });
      registrado = true;
      statusDepois = 'CONNECTED';
    } catch (error) {
      if (error instanceof HttpError && error.message.includes('133005')) {
        throw new HttpError(
          'PIN de verificacao em duas etapas incorreto. O numero ja possui 2FA; informe o PIN existente.',
        );
      }
      throw error;
    }
  }

  return { phone_number_id: phoneNumberId, pin, registrado, status_antes: statusAntes, status_depois: statusDepois };
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
  });

  const config = await fetchConfigApiOficial('app_id, app_secret');

  if (!config?.app_id || !config?.app_secret) {
    throw new HttpError('Config API Oficial incompleta em SAAS_Config_ApiOficial.');
  }

  logger.info('[meta-token] trocando code por token curto', { appId: config.app_id });
  
  const inboundConfig = getInboundConfig();
  const redirectUri = inboundConfig.publicWebhookUrls?.metaToken || '';
  
  const curto = await exchangeCodeForToken({
    version: metaGraphApiVersion,
    appId: config.app_id,
    appSecret: config.app_secret,
    code: entrada.code,
    redirectUri,
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

  const temIdsFront = !!waba_id && !!phone_number_id;

  if (temIdsFront) {
    logger.info('[meta-token] buscando telefone pelos IDs do front', { phone_number_id });
    const phoneRes = await fetchPhoneDetails(metaGraphApiVersion, phone_number_id, accessToken);
    Telefone = phoneRes.display_phone_number
      ? String(phoneRes.display_phone_number).replace(/\D/g, '')
      : null;
    verified_name = phoneRes.verified_name || null;
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
  });

  logger.info('[meta-token] subscribed_apps', { waba_id });
  await subscribeWaba(metaGraphApiVersion, waba_id, accessToken);
  const registro = await registerPhoneIfNeeded(metaGraphApiVersion, phone_number_id, accessToken);

  logger.info('[meta-token] registro numero', {
    phone_number_id,
    registrado: registro.registrado,
    status_antes: registro.status_antes,
    status_depois: registro.status_depois,
    pinGerado: Boolean(registro.pin),
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
  };

  if (registro.pin) {
    resposta.metaPinVerificacao = registro.pin;
    resposta.aviso_pin = 'Guarde este PIN de 6 digitos. Ele e a verificacao em duas etapas do numero na Meta.';
  }

  return resposta;
}
