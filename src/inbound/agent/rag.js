import { supabase } from '../../supabase.js';
import { logger } from '../../logger.js';
import { rankKnowledgeDocuments } from './knowledgeRanking.js';

async function createEmbedding(agentConfig, text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentConfig.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agentConfig.embeddingModel,
      input: text,
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || 'Falha ao gerar embedding');
  }
  return json.data?.[0]?.embedding;
}

export async function searchKnowledge(agentConfig, agenteId, query, matchCount = 5) {
  if (!agenteId || !query?.trim()) return [];

  const linkedPromise = supabase
    .from('SAAS_Conhecimentos')
    .select('content, metadata')
    // ->> converte JSON string e JSON number para texto, evitando incompatibilidade de tipo.
    .eq('metadata->>idAgente', String(agenteId))
    .limit(200);

  let vectorDocuments = [];
  let vectorError = null;
  try {
    const embedding = await createEmbedding(agentConfig, query);
    if (embedding) {
      const { data, error } = await supabase.rpc('match_documents', {
        query_embedding: embedding,
        match_count: Math.max(matchCount * 3, 15),
        filter: { idAgente: String(agenteId) },
      });
      if (error) throw new Error(error.message);
      vectorDocuments = (data ?? []).map((document) => ({
        content: document.content,
        metadata: document.metadata ?? {},
        similarity: Number.isFinite(Number(document.similarity))
          ? Number(document.similarity)
          : null,
        source: 'vector',
      }));
    }
  } catch (error) {
    vectorError = error.message;
  }

  const { data: linkedData, error: linkedError } = await linkedPromise;
  if (linkedError) {
    logger.warn('RAG: falha ao listar conhecimentos vinculados ao agente', {
      agenteId,
      message: linkedError.message,
    });
  }

  const linkedDocuments = (linkedData ?? []).map((document) => ({
    content: document.content,
    metadata: document.metadata ?? {},
    similarity: null,
    source: 'linked',
  }));
  const selected = rankKnowledgeDocuments({
    vectorDocuments,
    linkedDocuments,
    query,
    limit: matchCount,
  });

  logger.info('RAG: consulta de conhecimento concluída', {
    agenteId,
    pergunta: String(query).slice(0, 160),
    vinculados: linkedDocuments.length,
    vetoriais: vectorDocuments.length,
    selecionados: selected.length,
    erroVetor: vectorError,
    resultados: selected.map((document) => ({
      idUnico: document.metadata?.idUnico ?? document.metadata?.id_unico ?? null,
      source: document.source,
      similarity: document.similarity,
      lexicalScore: document.lexicalScore,
      embeddingModel: document.metadata?.embeddingModel ?? null,
      embeddingDimensions: document.metadata?.embeddingDimensions ?? null,
      preview: String(document.content).replace(/\s+/g, ' ').slice(0, 180),
    })),
  });

  return selected.map((document) => ({
      content: document.content,
      metadata: document.metadata ?? {},
      similarity: document.similarity,
      lexicalScore: document.lexicalScore,
      source: document.source,
    }));
}
