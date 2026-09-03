import { getEvolutionConfig } from '../../config.js';
import { buildInstanceName, resolveProvedorApi } from '../../provedorApi.js';
import {
  fetchContaComPlano,
  insertConexaoNaoOficial,
  obterApiNaoOficialConta,
  fetchConfigUazapi,
} from '../../supabase.js';
import { createUazapiClient, UazapiError } from '../../uazapi/client.js';
import { HttpError } from '../meta/httpError.js';
import { logger } from '../../logger.js';
import { WEBHOOK_PATHS, buildPublicWebhookUrl } from '../config.js';

function textoObrigatorio(value, campo) {
  const texto = String(value ?? '').trim();
  if (!texto) throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  return texto;
}

function extractEvolutionQr(createResponse) {
  const qr = createResponse?.qrcode || {};
  return {
    qrcode: qr.base64 || qr.code || createResponse?.base64 || null,
    pairingCode: qr.pairingCode || createResponse?.pairingCode || null,
    instanceName: createResponse?.instance?.instanceName || null,
    apikey: createResponse?.hash || createResponse?.apikey || null,
  };
}

function extractUazapiQr(payload) {
  const instance = payload?.instance || payload || {};
  const qrRaw =
    payload?.qrcode ||
    payload?.qr ||
    payload?.base64 ||
    instance?.qrcode ||
    null;

  let qrcode = null;
  if (typeof qrRaw === 'string') qrcode = qrRaw;
  else if (qrRaw && typeof qrRaw === 'object') {
    qrcode = qrRaw.base64 || qrRaw.code || null;
  }

  return {
    qrcode,
    pairingCode:
      payload?.pairingCode ||
      payload?.paircode ||
      payload?.code ||
      instance?.paircode ||
      null,
    instanceName: instance?.name || payload?.name || null,
    apikey: instance?.token || payload?.token || null,
  };
}

async function createEvolutionInstance({ instanceName, phoneNumber, inboundConfig }) {
  const config = getEvolutionConfig();
  const baseUrl = String(
    inboundConfig?.evolutionBaseUrl || config.evolutionBaseUrl || '',
  ).replace(/\/+$/, '');
  const apiKey = config.evolutionApiKey;

  const body = {
    instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
    rejectCall: false,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    syncFullHistory: false,
    readStatus: false,
  };
  if (phoneNumber) body.number = phoneNumber;

  const res = await fetch(`${baseUrl}/instance/create`, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(
      json?.message || json?.error || `Evolution create HTTP ${res.status}`,
      502,
    );
  }

  const parsed = extractEvolutionQr(json);
  if (!parsed.instanceName || !parsed.apikey) {
    throw new HttpError('Evolution nao retornou instanceName/apikey.', 502);
  }

  return { ...parsed, urlApi: baseUrl, globalApiKey: apiKey };
}

async function configureEvolutionWebhook({
  instanceName,
  apikey,
  urlApi,
  webhookUrl,
  globalApiKey,
}) {
  const res = await fetch(
    `${urlApi}/webhook/set/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: {
        apikey: globalApiKey || apikey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: ['MESSAGES_UPSERT'],
        },
      }),
    },
  );

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(
      json?.message || json?.error || `Evolution webhook HTTP ${res.status}`,
      502,
    );
  }
}

async function createUazapiInstance({ instanceName, phoneNumber }) {
  const config = await fetchConfigUazapi();
  const baseUrl = String(config?.url || '').replace(/\/+$/, '');
  const adminToken = String(config?.token || '').trim();

  if (!baseUrl || !adminToken) {
    throw new HttpError(
      'SAAS_Config_Uazapi incompleta (url/token). Configure no painel admin.',
      500,
    );
  }

  const client = createUazapiClient({ baseUrl, adminToken });
  const created = await client.createInstance({ name: instanceName });
  const createdParsed = extractUazapiQr(created);
  const token = createdParsed.apikey;
  if (!token) {
    throw new HttpError('UazAPI nao retornou token da instancia.', 502);
  }

  const instanceClient = client.withToken(token);
  const connected = await instanceClient.connect(
    phoneNumber ? { phone: phoneNumber } : {},
  );
  const connectedParsed = extractUazapiQr(connected);

  return {
    instanceName: createdParsed.instanceName || instanceName,
    apikey: token,
    qrcode: connectedParsed.qrcode || createdParsed.qrcode,
    pairingCode: connectedParsed.pairingCode || createdParsed.pairingCode,
    urlApi: baseUrl,
  };
}

async function configureUazapiWebhook({ urlApi, apikey, webhookUrl }) {
  const client = createUazapiClient({
    baseUrl: urlApi,
    instanceToken: apikey,
  });

  await client.setWebhook({
    url: webhookUrl,
    enabled: true,
    events: ['messages'],
    excludeMessages: ['wasSentByApi'],
    addUrlEvents: false,
  });
}

function buildWebhookUrl(inboundConfig, conexaoId, provedor) {
  const base =
    inboundConfig?.publicWebhookUrls?.evolution ||
    buildPublicWebhookUrl(inboundConfig.backUrl, WEBHOOK_PATHS.evolution);
  const url = new URL(base);
  url.searchParams.set('idConexao', String(conexaoId));
  if (provedor === 'uazapi') {
    url.searchParams.set('provedor', 'uazapi');
  }
  return url.toString();
}

/**
 * Cria conexão não oficial (Evolution ou UazAPI) conforme o plano da conta.
 * Compatível com o fluxo n8n `criarconexaoback`.
 */
export async function criarConexaoNaoOficial(body, inboundConfig) {
  const nomeExibicao = textoObrigatorio(body.instanceName, 'instanceName');
  const contaId = textoObrigatorio(body.contaId, 'contaId');
  const pairCode = Boolean(body.pairCode);
  const phoneNumber = body.phoneNumber
    ? String(body.phoneNumber).replace(/\D/g, '')
    : '';

  logger.info('[criar-conexao] inicio', {
    contaId,
    nomeExibicao,
    pairCode,
    hasPhoneNumber: Boolean(phoneNumber),
  });

  if (pairCode && !phoneNumber) {
    throw new HttpError('phoneNumber obrigatorio quando pairCode=true.', 400);
  }

  const contaPlano = await fetchContaComPlano(contaId);
  if (!contaPlano) throw new HttpError('Conta nao encontrada.', 404);

  const total = Number(contaPlano.total_conexoes || 0);
  const limite = Number(contaPlano.plano_qntConexoes || 0);
  if (!(total < limite)) {
    logger.warn('[criar-conexao] limite de conexoes atingido', {
      contaId,
      total,
      limite,
    });
    return { plano: 'limite atingido' };
  }

  const provedorRaw = await obterApiNaoOficialConta(contaId);
  const provedor = resolveProvedorApi({
    provedorApi: provedorRaw,
    apiOficial: false,
  });
  if (provedor !== 'evolution' && provedor !== 'uazapi') {
    throw new HttpError(`Provedor do plano invalido: ${provedorRaw}`, 400);
  }

  const instanceName = buildInstanceName(nomeExibicao);
  logger.info('[criar-conexao] criando instancia', {
    contaId,
    provedor,
    instanceName,
    pairCode,
  });

  let created;
  try {
    created =
      provedor === 'uazapi'
        ? await createUazapiInstance({
            instanceName,
            phoneNumber: pairCode ? phoneNumber : '',
          })
        : await createEvolutionInstance({
            instanceName,
            phoneNumber: pairCode ? phoneNumber : '',
            inboundConfig,
          });
  } catch (error) {
    logger.error('[criar-conexao] falha ao criar instancia', {
      contaId,
      provedor,
      instanceName,
      message: error instanceof Error ? error.message : String(error),
      status: error?.status || error?.statusCode || null,
      body: error?.body ?? null,
    });
    if (error instanceof HttpError) throw error;
    if (error instanceof UazapiError) {
      throw new HttpError(error.message, 502);
    }
    throw new HttpError(
      error instanceof Error ? error.message : 'Falha ao criar instancia',
      502,
    );
  }

  logger.info('[criar-conexao] instancia criada', {
    provedor,
    instanceName: created.instanceName,
    hasQrcode: Boolean(created.qrcode),
    hasPairingCode: Boolean(created.pairingCode),
    urlApi: created.urlApi,
  });

  let conexao;
  try {
    conexao = await insertConexaoNaoOficial({
      instanceName: created.instanceName,
      NomeConexao: nomeExibicao,
      contaId,
      Apikey: created.apikey,
      provedorApi: provedor,
      urlApi: created.urlApi,
      apiOficial: false,
    });
  } catch (error) {
    logger.error('[criar-conexao] falha ao salvar no banco', {
      contaId,
      provedor,
      instanceName: created.instanceName,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const webhookUrl = buildWebhookUrl(inboundConfig, conexao.id, provedor);
  logger.info('[criar-conexao] configurando webhook', {
    conexaoId: conexao.id,
    provedor,
    webhookUrl,
  });

  try {
    if (provedor === 'uazapi') {
      await configureUazapiWebhook({
        urlApi: created.urlApi,
        apikey: created.apikey,
        webhookUrl,
      });
    } else {
      await configureEvolutionWebhook({
        instanceName: created.instanceName,
        apikey: created.apikey,
        urlApi: created.urlApi,
        webhookUrl,
        globalApiKey: created.globalApiKey,
      });
    }
  } catch (error) {
    logger.error('[criar-conexao] falha ao configurar webhook', {
      conexaoId: conexao.id,
      provedor,
      webhookUrl,
      message: error instanceof Error ? error.message : String(error),
      status: error?.status || error?.statusCode || null,
      body: error?.body ?? null,
    });
    throw error instanceof HttpError
      ? error
      : new HttpError(
          error instanceof Error ? error.message : 'Falha ao configurar webhook',
          502,
        );
  }

  logger.info('[criar-conexao] ok', {
    conexaoId: conexao.id,
    provedor,
    instanceName: created.instanceName,
    hasQrcode: Boolean(created.qrcode),
    hasPairingCode: Boolean(created.pairingCode),
  });

  return {
    qrcode: created.qrcode,
    instanceName: created.instanceName,
    pairingCode: created.pairingCode,
    idConexao: conexao.id,
    provedorApi: provedor,
  };
}
