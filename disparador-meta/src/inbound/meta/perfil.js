import {
  fetchConfigApiOficial,
  fetchConexaoApiOficialById,
  updateConexaoApiOficial,
} from '../../supabase.js';
import { metaGet, metaPost, metaUploadBinary } from './graph.js';
import { HttpError } from './httpError.js';
import { buildPerfilResponse, META_VERTICALS } from './perfilLabels.js';

function pickField(body, perfil, key) {
  if (body[key] !== undefined && body[key] !== null && body[key] !== '') return body[key];
  if (perfil[key] !== undefined && perfil[key] !== null && perfil[key] !== '') return perfil[key];
  return undefined;
}

function parsePerfilInput(body) {
  const perfil = body.perfil && typeof body.perfil === 'object' ? body.perfil : {};
  const conexaoId = body.conexaoId || body.conexao_id;
  const acao = String(body.acao || body.action || 'consultar').toLowerCase();

  if (!conexaoId) throw new HttpError('Campo conexaoId obrigatorio.');
  if (!['consultar', 'sincronizar', 'atualizar'].includes(acao)) {
    throw new HttpError('acao deve ser consultar, sincronizar ou atualizar.');
  }

  const payload = {
    conexaoId,
    acao,
    about: pickField(body, perfil, 'about'),
    description: pickField(body, perfil, 'description'),
    address: pickField(body, perfil, 'address'),
    email: pickField(body, perfil, 'email'),
    vertical: pickField(body, perfil, 'vertical'),
    websites: body.websites ?? perfil.websites,
    foto_base64: body.foto_base64 || body.fotoBase64 || null,
    foto_mime: body.foto_mime || body.fotoMime || null,
  };

  if (acao === 'atualizar') {
    validateAtualizarPayload(payload);
  }

  return payload;
}

function hasField(payload, key) {
  const value = payload[key];
  if (key === 'websites') return Array.isArray(value) && value.length > 0;
  if (key === 'foto_base64') return typeof value === 'string' && value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

function validateAtualizarPayload(payload) {
  if (!['about', 'description', 'address', 'email', 'vertical', 'websites', 'foto_base64'].some((k) => hasField(payload, k))) {
    throw new HttpError('Informe ao menos um campo para atualizar.');
  }

  if (hasField(payload, 'about')) {
    const about = String(payload.about).trim();
    if (about.length < 1 || about.length > 139) throw new HttpError('about deve ter entre 1 e 139 caracteres.');
    payload.about = about;
  }

  if (hasField(payload, 'description')) {
    const description = String(payload.description).trim();
    if (description.length < 1 || description.length > 512) {
      throw new HttpError('description deve ter entre 1 e 512 caracteres.');
    }
    payload.description = description;
  }

  if (hasField(payload, 'address')) {
    const address = String(payload.address).trim();
    if (address.length < 1 || address.length > 256) throw new HttpError('address deve ter entre 1 e 256 caracteres.');
    payload.address = address;
  }

  if (hasField(payload, 'email')) {
    const email = String(payload.email).trim();
    if (email.length > 128 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError('email invalido (max 128 caracteres, formato valido).');
    }
    payload.email = email;
  }

  if (hasField(payload, 'vertical')) {
    const vertical = String(payload.vertical).trim().toUpperCase();
    if (!META_VERTICALS.includes(vertical)) {
      throw new HttpError('vertical invalido. Use um valor da enum Meta, ex: OTHER, RETAIL, RESTAURANT.');
    }
    payload.vertical = vertical;
  }

  if (payload.websites !== undefined && payload.websites !== null) {
    if (!Array.isArray(payload.websites)) throw new HttpError('websites deve ser array.');
    if (payload.websites.length > 2) throw new HttpError('websites max 2 URLs.');
    payload.websites = payload.websites.map((url) => String(url).trim()).filter(Boolean);
    if (!payload.websites.length) delete payload.websites;
    for (const url of payload.websites || []) {
      if (url.length > 256) throw new HttpError('cada URL max 256 caracteres.');
      if (!/^https?:\/\//i.test(url)) throw new HttpError('URLs devem comecar com http:// ou https://');
    }
  }

  if (hasField(payload, 'foto_base64')) {
    payload.foto_base64 = normalizeJpegBase64(payload.foto_base64);
    payload.foto_mime = 'image/jpeg';
  }
}

function normalizeJpegBase64(raw) {
  let b64 = String(raw).trim();
  const dataUrlMatch = b64.match(/^data:image\/\w+;base64,(.+)$/i);
  if (dataUrlMatch) b64 = dataUrlMatch[1];
  b64 = b64.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');

  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw new HttpError('foto_base64 invalida.');
  if (buffer.length > 5 * 1024 * 1024) throw new HttpError('Foto max 5MB.');

  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
  const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF';

  if (!isJpeg) {
    if (isPng) throw new HttpError('Meta exige JPG. Converta PNG para JPEG no front.');
    if (isWebp) throw new HttpError('Meta exige JPG. Converta WebP para JPEG no front.');
    throw new HttpError('Foto de perfil deve ser JPG (image/jpeg).');
  }

  return b64;
}

function getJpegDimensions(buffer) {
  let i = 2;
  while (i < buffer.length - 8) {
    if (buffer[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buffer[i + 1];
    if (marker === 0xd9) break;
    const len = buffer.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

async function loadConexaoContext(conexaoId) {
  const [config, conexao] = await Promise.all([
    fetchConfigApiOficial('app_id'),
    fetchConexaoApiOficialById(conexaoId),
  ]);

  if (!config?.app_id) throw new HttpError('Config API Oficial incompleta em SAAS_Config_ApiOficial.');
  if (!conexao?.access_token || !conexao?.phone_number_id) {
    throw new HttpError('Conexao nao encontrada ou sem phone_number_id.');
  }
  if (!conexao.waba_id) throw new HttpError('Conexao sem waba_id.');
  if (!conexao.apiOficial) throw new HttpError('Conexao nao e API Oficial.');

  return { config, conexao };
}

async function fetchMetaSyncData(ctx, version) {
  const { conexao } = ctx;
  const token = conexao.access_token;

  const [wabaRes, phoneNumbersRes, perfilRes] = await Promise.all([
    metaGet({
      version,
      path: conexao.waba_id,
      accessToken: token,
      query: {
        fields:
          'id,name,message_template_namespace,account_review_status,business_verification_status,whatsapp_business_manager_messaging_limit',
      },
    }),
    metaGet({
      version,
      path: `${conexao.waba_id}/phone_numbers`,
      accessToken: token,
      query: { fields: 'id,display_phone_number,verified_name,code_verification_status,quality_rating,status' },
    }),
    metaGet({
      version,
      path: `${conexao.phone_number_id}/whatsapp_business_profile`,
      accessToken: token,
      query: { fields: 'about,address,description,email,profile_picture_url,websites,vertical,messaging_product' },
    }),
  ]);

  let phoneDetailRes = await metaGet({
    version,
    path: conexao.phone_number_id,
    accessToken: token,
    query: {
      fields:
        'status,verified_name,display_phone_number,quality_rating,code_verification_status,name_status,new_display_name,new_name_status',
    },
    optional: true,
  });

  if (phoneDetailRes?.error) {
    phoneDetailRes = await metaGet({
      version,
      path: conexao.phone_number_id,
      accessToken: token,
      query: { fields: 'status,verified_name,display_phone_number,quality_rating,code_verification_status' },
      optional: true,
    });
  }

  const phoneNumbers = Array.isArray(phoneNumbersRes?.data) ? phoneNumbersRes.data : [];
  const phoneFromList =
    phoneNumbers.find((p) => String(p.id) === String(conexao.phone_number_id)) || phoneNumbers[0] || {};
  const phoneRes = phoneDetailRes?.error ? phoneFromList : { ...phoneFromList, ...phoneDetailRes };

  const perfil = Array.isArray(perfilRes.data) && perfilRes.data.length ? perfilRes.data[0] : {};
  const telefone = phoneRes.display_phone_number
    ? String(phoneRes.display_phone_number).replace(/\D/g, '')
    : conexao.Telefone || null;

  const limite =
    wabaRes.whatsapp_business_manager_messaging_limit ||
    conexao.metaMessagingLimit ||
    conexao.metaPhoneQualityLimit ||
    null;

  const now = new Date().toISOString();

  return {
    Telefone: telefone,
    FotoPerfil: perfil.profile_picture_url || conexao.FotoPerfil || null,
    metaVerifiedName: phoneRes.verified_name || null,
    metaNameStatus: phoneRes.name_status || null,
    metaNewDisplayName: phoneRes.new_display_name || null,
    metaNewNameStatus: phoneRes.new_name_status || null,
    metaPhoneStatus: phoneRes.status || null,
    metaQualityRating: phoneRes.quality_rating || null,
    metaBusinessVerificationStatus: wabaRes.business_verification_status || null,
    metaAccountReviewStatus: wabaRes.account_review_status || null,
    metaMessagingLimit: limite,
    metaWabaName: wabaRes.name || null,
    metaPerfil: perfil,
    metaPerfilUpdatedAt: now,
    metaDadosUpdatedAt: now,
  };
}

function buildUpdateTextBody(body, perfilReq) {
  const wasInBody = (key) =>
    Object.prototype.hasOwnProperty.call(body, key) || Object.prototype.hasOwnProperty.call(perfilReq, key);

  const wasEdited = (key) => {
    if (!wasInBody(key)) return false;
    const rawVal = body[key] !== undefined ? body[key] : perfilReq[key];
    if (key === 'websites') return Array.isArray(rawVal) && rawVal.some((u) => String(u).trim() !== '');
    return rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== '';
  };

  const valueOf = (key) => {
    const rawVal = body[key] !== undefined ? body[key] : perfilReq[key];
    if (key === 'websites') {
      if (!Array.isArray(rawVal)) return [];
      return rawVal.map((u) => String(u).trim()).filter(Boolean);
    }
    if (key === 'vertical') return String(rawVal).trim().toUpperCase();
    return String(rawVal).trim();
  };

  const textBody = { messaging_product: 'whatsapp' };

  if (wasEdited('about')) textBody.about = valueOf('about');
  if (wasEdited('description')) textBody.description = valueOf('description');
  if (wasEdited('address')) textBody.address = valueOf('address');
  if (wasEdited('email')) textBody.email = valueOf('email');
  if (wasEdited('vertical')) textBody.vertical = valueOf('vertical');
  if (wasEdited('websites')) textBody.websites = valueOf('websites');

  return { textBody, hasText: Object.keys(textBody).length > 1 };
}

async function uploadProfilePhoto({ version, appId, accessToken, fotoBase64 }) {
  const buffer = Buffer.from(fotoBase64, 'base64');
  const dims = getJpegDimensions(buffer);
  if (!dims || dims.width < 192 || dims.height < 192) {
    throw new HttpError('Foto de perfil deve ser JPG com no minimo 192x192 pixels.');
  }

  const session = await metaPost({
    version,
    path: `${appId}/uploads`,
    accessToken,
    query: {
      file_name: 'profile.jpg',
      file_length: String(buffer.length),
      file_type: 'image/jpeg',
    },
    body: {},
  });

  if (!session?.id) throw new HttpError('Falha ao criar sessao de upload na Meta.');

  const uploadRes = await metaUploadBinary({
    version,
    sessionId: session.id,
    accessToken,
    buffer,
  });

  if (!uploadRes?.h) throw new HttpError('Meta nao retornou handle da foto.');
  return uploadRes.h;
}

export async function handlePerfilMeta(body, { metaGraphApiVersion }) {
  const entrada = parsePerfilInput(body);
  const ctx = await loadConexaoContext(entrada.conexaoId);

  if (entrada.acao === 'consultar') {
    return buildPerfilResponse({ row: ctx.conexao, acao: 'consultar', cache: true });
  }

  if (entrada.acao === 'atualizar') {
    const perfilReq = body.perfil && typeof body.perfil === 'object' ? body.perfil : {};
    const { textBody, hasText } = buildUpdateTextBody(body, perfilReq);
    const temFoto = !!entrada.foto_base64;

    if (!hasText && !temFoto) throw new HttpError('Nenhum campo para atualizar.');

    if (temFoto) {
      const handle = await uploadProfilePhoto({
        version: metaGraphApiVersion,
        appId: ctx.config.app_id,
        accessToken: ctx.conexao.access_token,
        fotoBase64: entrada.foto_base64,
      });
      textBody.profile_picture_handle = handle;
    }

    if (hasText || temFoto) {
      const updateRes = await metaPost({
        version: metaGraphApiVersion,
        path: `${ctx.conexao.phone_number_id}/whatsapp_business_profile`,
        accessToken: ctx.conexao.access_token,
        body: textBody,
      });

      if (!updateRes?.success) {
        throw new HttpError('Meta nao confirmou atualizacao do perfil.');
      }
    }
  }

  const syncPayload = await fetchMetaSyncData(ctx, metaGraphApiVersion);
  const row = await updateConexaoApiOficial(entrada.conexaoId, syncPayload);

  return buildPerfilResponse({
    row: { ...ctx.conexao, ...row, ...syncPayload },
    acao: entrada.acao,
    cache: false,
  });
}
