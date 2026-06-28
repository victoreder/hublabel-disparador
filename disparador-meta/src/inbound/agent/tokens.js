import { logger } from '../../logger.js';
import { addTokensUsuarioPorAgente } from '../../supabase.js';

/** Multiplicador por modelo — mesma ordem do workflow n8n calcular-token. */
export function modelTokenMultiplier(modelRaw) {
  const model = String(modelRaw || '').toLowerCase();

  if (model.includes('gpt-5-pro')) return 60;
  if (model.includes('gpt-5-mini')) return 1;
  if (model.includes('gpt-5-nano')) return 0.2;
  if (model.includes('gpt-5')) return 5;
  if (model.includes('gpt-4.1-mini')) return 0.89;
  if (model.includes('gpt-4.1-nano')) return 0.22;
  if (model.includes('gpt-4.1')) return 4.44;
  if (model.includes('gpt-4o-mini')) return 0.33;
  if (model.includes('gpt-4o')) return 5.56;
  return 1;
}

/** Converte total de tokens OpenAI em créditos (1 casa decimal, mín. 0.1 se houve uso). */
export function computeTokenCredits(totalTokens, modelRaw) {
  const tokens = Number(totalTokens) || 0;
  if (tokens <= 0) return 0;

  let credits = (tokens / 1000) * modelTokenMultiplier(modelRaw);
  credits = Math.round(credits * 10) / 10;
  if (credits < 0.1) credits = 0.1;
  return credits;
}

export async function saveAgentTokenUsage(agenteId, totalTokens, modelRaw) {
  if (!agenteId) return null;

  const credits = computeTokenCredits(totalTokens, modelRaw);
  if (credits <= 0) return null;

  try {
    const resultado = await addTokensUsuarioPorAgente({
      id_agente: agenteId,
      qnt_tokens: credits,
    });

    if (resultado?.ok === false) {
      logger.warn('f_add_tokens_usuario_por_agente retornou erro', {
        agenteId,
        error: resultado.error,
      });
    } else {
      logger.info('Tokens IA registrados', {
        agenteId,
        totalTokens,
        credits,
        model: modelRaw,
      });
    }

    return resultado;
  } catch (error) {
    logger.warn('Falha ao registrar tokens IA', { agenteId, message: error.message });
    return null;
  }
}
