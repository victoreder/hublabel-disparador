import { supabase, fetchAgente, fetchOpenAIApiKey } from '../../supabase.js';
import { getAgentConfig } from '../agent/config.js';
import { getInboundConfig } from '../config.js';
import { HttpError } from '../meta/httpError.js';
import {
  buildPublicS3Url,
  createS3Client,
  sanitizeS3FileName,
  uploadBuffer,
} from '../storage/s3.js';
import { chunkText } from './chunk.js';
import { createEmbeddings } from './embeddings.js';
import { extractTextFromFile } from './extractText.js';
import { appendMediaLinksToText, normalizeMediaLinks } from './mediaLinks.js';
import {
  materializeProductMedia,
  mergeAgentProductIntoBody,
  replaceAgentProduct,
} from './productMediaUpload.js';
import { resolveProductContent } from './productText.js';

const INSERT_BATCH_SIZE = 50;

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Variável ${name} deve ser um número inteiro`);
  return parsed;
}

function normalizeIdentity(body = {}) {
  const userId = String(body.userId ?? body.contaId ?? body.conta_id ?? '').trim();
  const idAgenteRaw = body.idAgente ?? body.id_agente ?? body.agenteId;
  const idUnico = String(body.idUnico ?? body.id_unico ?? '').trim();
  if (!userId) throw new HttpError('userId é obrigatório', 400);
  if (idAgenteRaw == null || idAgenteRaw === '') throw new HttpError('idAgente é obrigatório', 400);
  if (!idUnico) throw new HttpError('idUnico é obrigatório', 400);
  const idAgente = Number(idAgenteRaw);
  if (!Number.isFinite(idAgente)) throw new HttpError('idAgente inválido', 400);
  return { userId, idAgente, idUnico };
}

function normalizePayload(body = {}, file) {
  const { userId, idAgente, idUnico } = normalizeIdentity(body);
  const text = resolveTextContent(body);
  const midias = normalizeMediaLinks(body);

  const fileFromBase64 = buildFileFromBase64(body);

  if (!file && !text && !fileFromBase64 && !midias.length) {
    throw new HttpError(
      'Envie text/conteudo/descricao/produto, um arquivo ou uma lista midias com links',
      400,
    );
  }

  return { userId, idAgente, idUnico, text, file: file ?? fileFromBase64, midias };
}

function resolveTextContent(body = {}) {
  const productText = resolveProductContent(body);
  if (productText) return productText;

  const raw =
    body.text ??
    body.conteudo ??
    body.documentoTexto ??
    body.conhecimento ??
    body.descricao ??
    body.produto ??
    null;

  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return JSON.stringify(raw, null, 2);
  return String(raw);
}

function buildFileFromBase64(body = {}) {
  const encoded = body.documentoBase64 ?? body.arquivoBase64 ?? body.base64 ?? null;
  if (!encoded) return null;

  const raw = String(encoded).includes(',') ? String(encoded).split(',').pop() : String(encoded);
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) return null;

  return {
    buffer,
    originalname: body.filename ?? body.fileName ?? body.nomeArquivo ?? 'documento.txt',
    mimetype: body.mimeType ?? body.mimetype ?? body.contentType ?? 'application/octet-stream',
  };
}

async function assertAgentOwnership({ userId, idAgente }) {
  const agente = await fetchAgente(idAgente);
  if (!agente) throw new HttpError('Agente não encontrado', 404);
  if (String(agente.contaId) !== String(userId)) {
    throw new HttpError('Agente não pertence à conta informada', 403);
  }
  return agente;
}

async function deleteKnowledgeByIdUnico(idUnico) {
  const { data, error } = await supabase.rpc('f_excluir_conhecimento_por_idunico', {
    p_idunico: idUnico,
  });

  if (error) {
    throw new Error(`Erro ao excluir conhecimento anterior: ${error.message}`);
  }

  return Number(data ?? 0);
}

async function insertKnowledgeRows(rows) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error } = await supabase.from('SAAS_Conhecimentos').insert(batch);
    if (error) {
      throw new Error(`Erro ao inserir conhecimento vetorizado: ${error.message}`);
    }
  }
}

async function materializeMedia({ body, agente, userId, idAgente, idUnico }) {
  let s3Client;
  let s3Config;
  const bodyWithSavedProduct = mergeAgentProductIntoBody(body, agente?.produtos, idUnico);
  const result = await materializeProductMedia(bodyWithSavedProduct, {
    maxBytes: optionalInt('RAG_MAX_MEDIA_BYTES', 20 * 1024 * 1024),
    upload: async ({ buffer, mimeType, extension, hash }) => {
      if (!s3Config) {
        s3Config = getInboundConfig().s3;
        s3Client = createS3Client(s3Config);
      }
      const safeUser = sanitizeS3FileName(userId, 'conta');
      const safeAgent = sanitizeS3FileName(String(idAgente), 'agente');
      const safeProduct = sanitizeS3FileName(idUnico, 'produto');
      const key = `rag/produtos/${safeUser}/${safeAgent}/${safeProduct}/${hash}.${extension}`;
      await uploadBuffer({
        client: s3Client,
        bucket: s3Config.bucket,
        key,
        body: buffer,
        contentType: mimeType,
      });
      return { url: buildPublicS3Url(s3Config.publicBaseUrl, key) };
    },
  });

  if (result.uploadedMedia.length && result.product) {
    const produtos = replaceAgentProduct(agente?.produtos, result.product, idUnico);
    if (produtos != null) {
      const { error } = await supabase.from('SAAS_AgentesIA').update({ produtos }).eq('id', idAgente);
      if (error) throw new Error(`Erro ao substituir base64 do produto por URL: ${error.message}`);
    }
  }

  return result;
}

export async function ingestKnowledgeDocument({ body, file }) {
  const identity = normalizeIdentity(body);
  const agente = await assertAgentOwnership(identity);
  const prepared = await materializeMedia({ body, agente, ...identity });
  const {
    userId,
    idAgente,
    idUnico,
    text,
    file: normalizedFile,
    midias,
  } = normalizePayload(prepared.body, file);

  const agentConfig = await getAgentConfig();
  const openaiApiKey = agentConfig.openaiApiKey || (await fetchOpenAIApiKey());

  const sourceText = normalizedFile
    ? await extractTextFromFile(normalizedFile)
    : String(text ?? '').trim();
  const rawText = appendMediaLinksToText(sourceText, midias);
  const chunks = chunkText(rawText, {
    chunkSize: optionalInt('RAG_CHUNK_SIZE', 1000),
    overlap: optionalInt('RAG_CHUNK_OVERLAP', 200),
  });

  if (!chunks.length) {
    throw new HttpError('Documento sem conteúdo utilizável após processamento', 400);
  }

  const deleted = await deleteKnowledgeByIdUnico(idUnico);

  const embeddings = await createEmbeddings(openaiApiKey, agentConfig.embeddingModel, chunks);

  const metadata = {
    userId: String(userId),
    idAgente: String(idAgente),
    idUnico: String(idUnico),
    midias,
    embeddingModel: agentConfig.embeddingModel,
    embeddingDimensions: embeddings[0]?.length ?? null,
    indexedAt: new Date().toISOString(),
  };

  const rows = chunks.map((content, index) => ({
    content,
    metadata,
    embedding: embeddings[index],
  }));

  await insertKnowledgeRows(rows);

  return {
    ok: true,
    acao: 'inserirDocumento',
    idUnico,
    idAgente,
    userId,
    chunks: rows.length,
    midias: midias.length,
    midiasEnviadasAoStorage: prepared.uploadedMedia.length,
    deleted,
    embeddingModel: agentConfig.embeddingModel,
  };
}
