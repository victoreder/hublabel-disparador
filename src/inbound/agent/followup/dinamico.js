import { logger } from '../../../logger.js';
import { computeTokenCredits } from '../tokens.js';

const TZ = 'America/Sao_Paulo';

const SINAL_PRAZO =
  /amanh[aã]|semana\s+que\s+vem|pr[oó]xim[ao]|in[ií]cio\s+do\s+m[eê]s|fim\s+do\s+m[eê]s|depois\s+de|daqui\s+a|me\s+chama|me\s+liga|retorn[ae]|volta\s+a\s+falar|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|\b\d{1,2}\s*\/\s*\d{1,2}|\b\d{1,2}\s+de\s+|às\s+\d|as\s+\d+\s*h|hora|viagem|viajem|ocupad|corrido|mês\s+que\s+vem|mes\s+que\s+vem/i;

export function lerFollowupDinamico(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw.dinamico;
  if (!d || typeof d !== 'object' || !d.ativo) return null;
  const teto = Math.min(365, Math.max(1, Math.floor(Number(d.tetoDias) || 30)));
  return {
    ativo: true,
    instrucoes: String(d.instrucoes || '').trim(),
    desligarCadencia: d.desligarCadencia !== false,
    tetoDias: teto,
  };
}

export function temSinalDePrazo(texto) {
  return SINAL_PRAZO.test(String(texto || ''));
}

export function agoraSpLabel(agora = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(agora);
}

/** Descarta passado, vago demais ou além do teto. Exige pelo menos 5 min no futuro. */
export function validarQuando(iso, tetoDias, agora = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= agora.getTime() + 5 * 60_000) return null;
  const teto = Math.min(365, Math.max(1, tetoDias));
  if (d.getTime() > agora.getTime() + teto * 86400000) return null;
  return d;
}

function extrairJson(texto) {
  const raw = String(texto || '').trim();
  const ini = raw.indexOf('{');
  const fim = raw.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const v = JSON.parse(raw.slice(ini, fim + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function detectarPrazoFollowup({
  agentConfig,
  mensagemCliente,
  historico,
  tetoDias,
}) {
  const msg = String(mensagemCliente || '').trim();
  if (!msg || !temSinalDePrazo(msg) || !agentConfig?.openaiApiKey) return null;

  const agora = new Date();
  const prompt = [
    `Agora é ${agoraSpLabel(agora)} (fuso America/Sao_Paulo).`,
    'O cliente pediu para ser contactado de novo em um momento futuro específico?',
    'Só considere prazo claro (amanhã, semana que vem, início do mês, uma data, um dia da semana, um horário).',
    'Frase vaga (“depois eu vejo”, “mais tarde”, “qualquer hora”) NÃO agenda.',
    'Se for para agendar, devolva JSON: {"agendar":true,"quando":"YYYY-MM-DDTHH:mm:ss-03:00"}',
    'Se não, devolva {"agendar":false}.',
    'Regras de horário (America/Sao_Paulo):',
    '- Só o dia, sem hora → 09:00.',
    '- “amanhã” → amanhã 09:00.',
    '- “semana que vem” → próxima segunda 09:00.',
    '- “início do mês” → dia 1 do próximo mês 09:00.',
    '- Só datas/horários no futuro.',
    `Teto: não passe de ${tetoDias} dias a partir de agora.`,
    '',
    `Última mensagem do cliente:\n${msg.slice(0, 2000)}`,
  ].join('\n');

  const hist = (historico || [])
    .filter((h) => h.role === 'user' || h.role === 'assistant')
    .slice(-8)
    .map((h) => ({
      role: h.role,
      content: String(h.content || '').slice(0, 500),
    }));

  const modelo = agentConfig.pendingAnalysisModel || 'gpt-4o-mini';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentConfig.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelo,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Responda apenas JSON válido. Sem markdown.' },
          ...hist,
          { role: 'user', content: prompt },
        ],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);

    const texto = String(json.choices?.[0]?.message?.content || '').trim();
    const promptTokens = Number(json.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(json.usage?.completion_tokens ?? 0);
    const tot = Number(json.usage?.total_tokens ?? 0) || promptTokens + completionTokens;
    const parsed = extrairJson(texto);
    const quando =
      parsed?.agendar === true ? validarQuando(String(parsed.quando || ''), tetoDias, agora) : null;

    return {
      quando,
      promptTokens,
      completionTokens,
      creditos: computeTokenCredits(tot, modelo),
      modelo,
    };
  } catch (err) {
    logger.warn('Follow-up: falha ao detectar prazo', { message: err.message });
    return null;
  }
}
