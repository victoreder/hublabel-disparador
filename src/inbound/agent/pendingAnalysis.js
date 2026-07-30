import { logger } from '../../logger.js';

/**
 * Decide se a resposta já enviada cobre a mensagem pendente.
 * @returns {Promise<boolean>} true = pendente já respondida (descartar)
 */
export async function analyzePendingCovered({
  agentConfig,
  inputText,
  replyText,
  pendingText,
  job,
}) {
  const pending = String(pendingText || '').trim();
  const reply = String(replyText || '').trim();
  const input = String(inputText || '').trim();

  if (!pending) return true;
  if (!reply) return false;

  // Heurística barata antes do LLM
  const pendingNorm = pending.toLowerCase();
  const replyNorm = reply.toLowerCase();
  if (pendingNorm.length <= 4 && ['ok', 'sim', 'nao', 'não', 'blz', 'valeu', 'obrigado', 'obrigada'].includes(pendingNorm)) {
    logger.info('PendingAnalysis: heurística curta — considerada coberta', {
      conversaId: job?.conversaId,
      pending,
    });
    return true;
  }

  if (!agentConfig?.openaiApiKey) {
    logger.warn('PendingAnalysis: sem OpenAI key — processando pendente');
    return false;
  }

  const model = agentConfig.pendingAnalysisModel || 'gpt-4o-mini';
  const prompt = [
    'Você é um classificador. Responda APENAS com SIM ou NAO.',
    'A RESPOSTA_DO_AGENTE já responde de forma útil a MENSAGEM_PENDENTE?',
    'SIM = a pendente já foi respondida (não precisa nova resposta do agente).',
    'NAO = a pendente traz pergunta, dado ou assunto que a resposta NÃO cobre.',
    'NAO também se a pendente responde uma pergunta que a própria RESPOSTA_DO_AGENTE acabou de fazer',
    '(ex.: agente pergunta "quantos clientes?" e a pendente diz "uns 30") — isso precisa de nova resposta.',
    'Na dúvida, responda NAO.',
    '',
    `MENSAGEM_ORIGINAL:\n${input.slice(0, 1500)}`,
    '',
    `RESPOSTA_DO_AGENTE:\n${reply.slice(0, 2000)}`,
    '',
    `MENSAGEM_PENDENTE:\n${pending.slice(0, 1500)}`,
  ].join('\n');

  logger.info('PendingAnalysis: consultando modelo', {
    conversaId: job?.conversaId,
    model,
    pendingPreview: pending.slice(0, 120),
  });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentConfig.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 5,
      messages: [
        { role: 'system', content: 'Responda apenas SIM ou NAO.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || 'Falha na análise de pendente');
  }

  const answer = String(json.choices?.[0]?.message?.content || '')
    .trim()
    .toUpperCase();
  const covered = answer.startsWith('SIM');

  logger.info('PendingAnalysis: resultado', {
    conversaId: job?.conversaId,
    answer,
    covered,
  });

  return covered;
}
