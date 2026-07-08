const EMBEDDING_BATCH_SIZE = 64;

export async function createEmbeddings(apiKey, model, texts) {
  if (!texts.length) return [];

  const all = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: batch,
      }),
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.error?.message || 'Falha ao gerar embeddings');
    }

    const ordered = (json.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (ordered.length !== batch.length) {
      throw new Error('OpenAI retornou quantidade de embeddings diferente do esperado');
    }

    all.push(...ordered);
  }

  return all;
}
