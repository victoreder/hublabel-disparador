import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { createEvolutionClient, mapMessageType } from '../../evolution/client.js';
import {
  isEnderecamentoFallbackError,
  isLidJid,
  normalizeLidJid,
  resolveLidDoTelefone,
} from '../../evolution/lid.js';
import { logger } from '../../logger.js';
import { resolveProvedorApi } from '../../provedorApi.js';
import {
  fetchConexaoById,
  fetchContextoEnvioChat,
  marcarMensagemChatEnviada,
} from '../../supabase.js';
import { invalidateChatHistory } from '../agent/memory.js';
import {
  createUazapiClient,
  extractUazapiMessageId,
  mapEvolutionMediaTypeToUazapi,
} from '../../uazapi/client.js';
import { metaPost } from '../meta/graph.js';
import { HttpError } from '../meta/httpError.js';
import {
  buildPublicS3Url,
  createS3Client,
  sanitizeS3FileName,
  uploadBuffer,
} from '../storage/s3.js';

const TIPOS_MIDIA = {
  audioMessage: 'audio',
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

function textoObrigatorio(value, campo) {
  const texto = String(value ?? '').trim();
  if (!texto) throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  return texto;
}

function inteiroObrigatorio(value, campo) {
  const numero = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new HttpError(`Campo ${campo} obrigatorio.`, 400);
  }
  return numero;
}

function idResposta(response, provedor) {
  if (provedor === 'uazapi') {
    return extractUazapiMessageId(response);
  }
  return (
    response?.key?.id ||
    response?.messages?.[0]?.id ||
    response?.messageId ||
    extractUazapiMessageId(response) ||
    null
  );
}

function telefoneMeta(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) throw new HttpError('Telefone do contato nao encontrado.', 400);
  return digits;
}

function telefoneContexto(contexto, body) {
  return (
    contexto.contato?.telefone ||
    contexto.conversa?.telefone ||
    body.telefone ||
    null
  );
}

function telefoneDigitsParaUazapi(value) {
  return String(value ?? '')
    .replace(/@.+$/, '')
    .replace(/\D/g, '');
}

async function carregarContexto(body) {
  const idConexao = inteiroObrigatorio(body.idConexao, 'idConexao');
  const idMensagem = inteiroObrigatorio(body.idMensagem, 'idMensagem');
  const [conexao, contexto] = await Promise.all([
    fetchConexaoById(idConexao),
    fetchContextoEnvioChat(idMensagem, idConexao),
  ]);

  if (!conexao) throw new HttpError('Conexao nao encontrada.', 404);
  if (!contexto || contexto.mensagem.contaId !== conexao.contaId) {
    throw new HttpError('Mensagem nao pertence a conexao informada.', 403);
  }

  let contextoLegenda = null;
  if (body.idMensagem2 != null && body.idMensagem2 !== '') {
    const idMensagem2 = inteiroObrigatorio(body.idMensagem2, 'idMensagem2');
    contextoLegenda = await fetchContextoEnvioChat(idMensagem2, idConexao);
    if (
      !contextoLegenda ||
      contextoLegenda.mensagem.contaId !== conexao.contaId ||
      contextoLegenda.conversa.id !== contexto.conversa.id
    ) {
      throw new HttpError('Mensagem da legenda nao pertence a mesma conversa.', 403);
    }
  }

  return { conexao, contexto, contextoLegenda, idConexao, idMensagem };
}

function clienteEvolution(conexao, inboundConfig) {
  const baseUrl = String(
    conexao.urlApi || inboundConfig.evolutionBaseUrl || '',
  ).replace(/\/+$/, '');
  if (!baseUrl || !conexao.instanceName || !conexao.Apikey) {
    throw new HttpError('Conexao Evolution incompleta.', 400);
  }

  return createEvolutionClient({
    evolutionBaseUrl: baseUrl,
    evolutionApiKey: conexao.Apikey,
  });
}

function clienteUazapi(conexao) {
  const baseUrl = String(conexao.urlApi || '').replace(/\/+$/, '');
  if (!baseUrl || !conexao.Apikey) {
    throw new HttpError('Conexao UazAPI incompleta (urlApi/Apikey).', 400);
  }
  return createUazapiClient({
    baseUrl,
    instanceToken: conexao.Apikey,
  });
}

async function destinosEvolution({ evolution, conexao, contexto, body }) {
  const telefone = telefoneContexto(contexto, body);
  if (!telefone) throw new HttpError('Telefone do contato nao encontrado.', 400);

  const lid = normalizeLidJid(contexto.contato?.lid);
  return {
    telefone,
    lid,
    evolution,
    instanceName: conexao.instanceName,
  };
}

async function enviarEvolutionComFallback(enderecamento, enviar) {
  const { telefone, lid, evolution, instanceName } = enderecamento;
  const fila = lid ? [lid, telefone] : [telefone];
  const tentados = new Set();
  let ultimoErro;

  while (fila.length) {
    const destino = fila.shift();
    if (!destino || tentados.has(destino)) continue;
    tentados.add(destino);

    try {
      const response = await enviar(destino);
      return { response, destino };
    } catch (error) {
      if (!isEnderecamentoFallbackError(error)) throw error;
      ultimoErro = error;

      logger.warn('[chat-envio] tentando outro enderecamento Evolution', {
        instanceName,
        enderecamento: isLidJid(destino) ? 'lid' : 'telefone',
        message: error instanceof Error ? error.message : String(error),
      });

      if (!fila.length && !isLidJid(destino)) {
        const lidResolvido = await resolveLidDoTelefone({
          evolutionClient: evolution,
          instanceName,
          telefone: destino,
        });
        if (lidResolvido) fila.push(lidResolvido);
      }
    }
  }

  throw ultimoErro || new HttpError('Falha ao enviar pela Evolution.', 502);
}

function payloadMetaTexto(to, mensagem, mensagemRespondida) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: mensagem },
  };
  if (mensagemRespondida) payload.context = { message_id: mensagemRespondida };
  return payload;
}

async function enviarMeta(conexao, inboundConfig, payload) {
  if (!conexao.access_token || !conexao.phone_number_id) {
    throw new HttpError('Conexao API Oficial incompleta.', 400);
  }

  return metaPost({
    version: inboundConfig.metaGraphApiVersion,
    path: `${conexao.phone_number_id}/messages`,
    accessToken: conexao.access_token,
    body: payload,
  });
}

async function uploadArquivo(file, inboundConfig, idMensagem) {
  if (!file?.buffer?.length) throw new HttpError('Arquivo obrigatorio.', 400);

  const original = sanitizeS3FileName(file.originalname, `arquivo${extname(file.originalname || '')}`);
  const key = `chat/${idMensagem}/${randomUUID()}-${original}`;
  const client = createS3Client(inboundConfig.s3);

  await uploadBuffer({
    client,
    bucket: inboundConfig.s3.bucket,
    key,
    body: file.buffer,
    contentType: file.mimetype || 'application/octet-stream',
  });

  return {
    url: buildPublicS3Url(inboundConfig.s3.publicBaseUrl, key),
    nome: original,
    mimetype: file.mimetype || 'application/octet-stream',
  };
}

function invalidarHistoricoAgente(contexto) {
  const conversaId = contexto?.conversa?.id ?? contexto?.mensagem?.conversaId;
  if (conversaId == null) return;
  void invalidateChatHistory(conversaId).catch(() => {});
}

export async function enviarMensagemChat(body, inboundConfig) {
  const { conexao, contexto, idMensagem } = await carregarContexto(body);
  const mensagem = textoObrigatorio(body.mensagem, 'mensagem');
  const provedor = resolveProvedorApi(conexao);
  let response;
  let destino;

  if (provedor === 'oficial') {
    destino = telefoneMeta(telefoneContexto(contexto, body));
    response = await enviarMeta(
      conexao,
      inboundConfig,
      payloadMetaTexto(destino, mensagem, body.mensagemRespondida),
    );
  } else if (provedor === 'uazapi') {
    const uazapi = clienteUazapi(conexao);
    destino = telefoneDigitsParaUazapi(telefoneContexto(contexto, body));
    if (!destino) throw new HttpError('Telefone do contato nao encontrado.', 400);
    response = await uazapi.sendText(destino, mensagem, {
      ...(body.mensagemRespondida
        ? { quoted: String(body.mensagemRespondida) }
        : {}),
    });
  } else {
    const evolution = clienteEvolution(conexao, inboundConfig);
    const enderecamento = await destinosEvolution({ evolution, conexao, contexto, body });
    const resultado = await enviarEvolutionComFallback(enderecamento, (number) =>
      evolution.sendText(conexao.instanceName, number, mensagem, {
        ...(body.mensagemRespondida
          ? { quoted: { key: { id: String(body.mensagemRespondida) } } }
          : {}),
      }),
    );
    response = resultado.response;
    destino = resultado.destino;
  }

  const messageId = idResposta(response, provedor);
  if (!messageId) throw new HttpError('Provedor nao retornou o id da mensagem.', 502);

  await marcarMensagemChatEnviada(idMensagem, {
    tipoMensagem: 'conversation',
    ...(provedor === 'oficial'
      ? { metaMessageId: messageId, metaStatus: 'sent' }
      : { messageEvolutionId: messageId }),
  });
  invalidarHistoricoAgente(contexto);

  return {
    ok: true,
    acao: 'enviarMensagem',
    provedor,
    messageId,
    enderecamento: provedor === 'oficial' || provedor === 'uazapi'
      ? 'telefone'
      : isLidJid(destino)
        ? 'lid'
        : 'telefone',
  };
}

async function enviarLegendaAudio({
  body,
  conexao,
  contexto,
  contextoLegenda,
  inboundConfig,
  evolution,
  uazapi,
  enderecamento,
}) {
  const legenda = String(body.caption ?? '').trim();
  if (!legenda) return null;
  const provedor = resolveProvedorApi(conexao);

  let response;
  if (provedor === 'oficial') {
    const to = telefoneMeta(telefoneContexto(contexto, body));
    response = await enviarMeta(conexao, inboundConfig, payloadMetaTexto(to, legenda));
  } else if (provedor === 'uazapi') {
    const number = telefoneDigitsParaUazapi(telefoneContexto(contexto, body));
    response = await uazapi.sendText(number, legenda);
  } else {
    const resultado = await enviarEvolutionComFallback(enderecamento, (number) =>
      evolution.sendText(conexao.instanceName, number, legenda),
    );
    response = resultado.response;
  }

  const messageId = idResposta(response, provedor);
  if (!messageId) throw new HttpError('Provedor nao retornou o id da legenda.', 502);

  if (contextoLegenda) {
    await marcarMensagemChatEnviada(contextoLegenda.mensagem.id, {
      tipoMensagem: 'conversation',
      ...(provedor === 'oficial'
        ? { metaMessageId: messageId, metaStatus: 'sent' }
        : { messageEvolutionId: messageId }),
    });
    invalidarHistoricoAgente(contextoLegenda);
  }

  return messageId;
}

export async function enviarMidiaChat(body, file, inboundConfig) {
  const { conexao, contexto, contextoLegenda, idMensagem } = await carregarContexto(body);
  const tipoMensagem = textoObrigatorio(body.type, 'type');
  const tipoMeta = TIPOS_MIDIA[tipoMensagem];
  if (!tipoMeta) throw new HttpError(`Tipo de midia nao suportado: ${tipoMensagem}`, 400);

  const provedor = resolveProvedorApi(conexao);
  const arquivo = await uploadArquivo(file, inboundConfig, idMensagem);
  let evolution = null;
  let uazapi = null;
  let enderecamento = null;

  if (provedor === 'uazapi') {
    uazapi = clienteUazapi(conexao);
  } else if (provedor === 'evolution') {
    evolution = clienteEvolution(conexao, inboundConfig);
    enderecamento = await destinosEvolution({ evolution, conexao, contexto, body });
  }

  const captionMessageId =
    tipoMensagem === 'audioMessage'
      ? await enviarLegendaAudio({
          body,
          conexao,
          contexto,
          contextoLegenda,
          inboundConfig,
          evolution,
          uazapi,
          enderecamento,
        })
      : null;

  let response;
  let destino;
  if (provedor === 'oficial') {
    destino = telefoneMeta(telefoneContexto(contexto, body));
    const media = { link: arquivo.url };
    if (body.caption && tipoMensagem !== 'audioMessage') media.caption = String(body.caption);
    if (tipoMensagem === 'documentMessage') media.filename = arquivo.nome;

    response = await enviarMeta(conexao, inboundConfig, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      type: tipoMeta,
      [tipoMeta]: media,
    });
  } else if (provedor === 'uazapi') {
    destino = telefoneDigitsParaUazapi(telefoneContexto(contexto, body));
    if (!destino) throw new HttpError('Telefone do contato nao encontrado.', 400);
    const type = mapEvolutionMediaTypeToUazapi(tipoMensagem);
    response = await uazapi.sendMedia({
      number: destino,
      type,
      file: arquivo.url,
      ...(body.caption && tipoMensagem !== 'audioMessage'
        ? { text: String(body.caption) }
        : {}),
      ...(tipoMensagem === 'documentMessage' ? { docName: arquivo.nome } : {}),
    });
  } else if (tipoMensagem === 'audioMessage') {
    const resultado = await enviarEvolutionComFallback(enderecamento, (number) =>
      evolution.sendWhatsAppAudio(conexao.instanceName, number, arquivo.url),
    );
    response = resultado.response;
    destino = resultado.destino;
  } else {
    const resultado = await enviarEvolutionComFallback(enderecamento, (number) =>
      evolution.sendMedia(conexao.instanceName, {
        number,
        mediatype: tipoMeta,
        mimetype: arquivo.mimetype,
        media: arquivo.url,
        fileName: arquivo.nome,
        ...(body.caption ? { caption: String(body.caption) } : {}),
      }),
    );
    response = resultado.response;
    destino = resultado.destino;
  }

  const messageId = idResposta(response, provedor);
  if (!messageId) throw new HttpError('Provedor nao retornou o id da midia.', 502);

  await marcarMensagemChatEnviada(idMensagem, {
    tipoMensagem:
      provedor === 'uazapi' ? tipoMensagem : mapMessageType(tipoMensagem, response),
    arquivoUrl: arquivo.url,
    ...(provedor === 'oficial'
      ? { metaMessageId: messageId, metaStatus: 'sent' }
      : { messageEvolutionId: messageId }),
  });
  invalidarHistoricoAgente(contexto);

  return {
    ok: true,
    acao: 'enviarMidia',
    provedor,
    messageId,
    captionMessageId,
    arquivoUrl: arquivo.url,
    enderecamento:
      provedor === 'oficial' || provedor === 'uazapi'
        ? 'telefone'
        : isLidJid(destino)
          ? 'lid'
          : 'telefone',
  };
}
