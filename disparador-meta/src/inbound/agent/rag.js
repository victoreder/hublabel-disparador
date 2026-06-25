import { supabase } from '../../supabase.js';

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

  const embedding = await createEmbedding(agentConfig, query);
  if (!embedding) return [];

  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_count: matchCount,
    filter: { idAgente: String(agenteId) },
  });

  if (error) {
    throw new Error(`Erro em match_documents: ${error.message}`);
  }

  return (data ?? []).map((d) => d.content).filter(Boolean);
}
