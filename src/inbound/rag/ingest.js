import { supabase, fetchAgente, fetchOpenAIApiKey } from '../../supabase.js';
import { getAgentConfig } from '../agent/config.js';
import { HttpError } from '../meta/httpError.js';
import { chunkText } from './chunk.js';
import { createEmbeddings } from './embeddings.js';
import { extractTextFromFile, extractTextFromPlain } from './extractText.js';

const INSERT_BATCH_SIZE = 50;

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Variável ${name} deve ser um número inteiro`);
  return parsed;
}

function normalizePayload(body = {}, file) {
  const userId = String(body.userId ?? body.contaId ?? body.conta_id ?? '').trim();
  const idAgenteRaw = body.idAgente ?? body.id_agente ?? body.agenteId;
  const idUnico = String(body.idUnico ?? body.id_unico ?? '').trim();
  const text = body.text ?? body.conteudo ?? null;

  if (!userId) throw new HttpError('userId é obrigatório', 400);
  if (idAgenteRaw == null || idAgenteRaw === '') throw new HttpError('idAgente é obrigatório', 400);
  if (!idUnico) throw new HttpError('idUnico é obrigatório', 400);

  const idAgente = Number(idAgenteRaw);
  if (!Number.isFinite(idAgente)) throw new HttpError('idAgente inválido', 400);

  if (!file && !text) {
    throw new HttpError('Envie um arquivo (campo data ou file) ou o campo text', 400);
  }

  return { userId, idAgente, idUnico, text, file };
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

export async function ingestKnowledgeDocument({ body, file }) {
  const { userId, idAgente, idUnico, text } = normalizePayload(body, file);

  await assertAgentOwnership({ userId, idAgente });

  const agentConfig = await getAgentConfig();
  const openaiApiKey = agentConfig.openaiApiKey || (await fetchOpenAIApiKey());

  const rawText = file ? await extractTextFromFile(file) : await extractTextFromPlain(text);
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
    deleted,
    embeddingModel: agentConfig.embeddingModel,
  };
}
