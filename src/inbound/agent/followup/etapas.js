import { logger } from '../../../logger.js';
import { supportsCustomTemperature } from '../config.js';
import { computeTokenCredits } from '../tokens.js';

export const SLUG_ENCERRADO = 'encerrado';

function slugify(texto, fallback) {
  const s = String(texto || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return s || fallback;
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

export function formatarHistoricoClassificador(historico, limite = 20) {
  return (historico || [])
    .filter((h) => h?.role === 'user' || h?.role === 'assistant')
    .slice(-limite)
    .map((h) => {
      const quem = h.role === 'user' ? 'Cliente' : 'Agente';
      const texto = String(h.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      return texto ? `${quem}: ${texto}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

/** Follow-up avançado = array etapas configurado. Tem prioridade sobre o cadência padrão (`passos`). */
export function temFollowupAvancado(raw) {
  return Boolean(raw && typeof raw === 'object' && Array.isArray(raw.etapas) && raw.etapas.length);
}

/** Etapas válidas na ordem do funil. Ignora item sem critério ou sem passos com atraso. */
export function lerEtapasFollowup(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const lista = Array.isArray(raw.etapas) ? raw.etapas : [];
  const vistos = new Set();
  const out = [];

  lista.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const criterio = String(item.criterio || item.criterioSaida || '').trim();
    if (!criterio) return;

    const nome = String(item.nome || '').trim() || `Etapa ${index + 1}`;
    let slug = slugify(item.slug || nome, `etapa_${index + 1}`);
    if (slug === SLUG_ENCERRADO) slug = `etapa_${index + 1}`;
    if (vistos.has(slug)) slug = `${slug}_${index + 1}`;
    vistos.add(slug);

    const passos = Array.isArray(item.passos) ? item.passos : [];
    if (!passos.length) return;

    out.push({
      slug,
      nome,
      criterio,
      perguntaPendente: String(item.perguntaPendente || item.pergunta || '').trim(),
      passos,
    });
  });

  return out;
}

export function etapaPorSlug(etapas, slug) {
  const s = String(slug || '').trim();
  if (!s || s === SLUG_ENCERRADO) return null;
  return (etapas || []).find((e) => e.slug === s) || null;
}

export function indicePassoEtapa(progresso, slug) {
  const n = Number(progresso?.[slug]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Classifica a primeira etapa cujo critério ainda NÃO foi cumprido.
 * @returns {Promise<{ slug: string|null, promptTokens: number, completionTokens: number, creditos: number, modelo: string|null }>}
 */
export async function classificarEtapaFollowup({ agentConfig, historico, etapas }) {
  const lista = Array.isArray(etapas) ? etapas : [];
  if (!lista.length) {
    return { slug: null, falhou: false, promptTokens: 0, completionTokens: 0, creditos: 0, modelo: null };
  }
  if (!agentConfig?.openaiApiKey) {
    logger.warn('Follow-up etapas: sem OpenAI key — não classifica');
    return { slug: null, falhou: true, promptTokens: 0, completionTokens: 0, creditos: 0, modelo: null };
  }

  const permitidos = [...lista.map((e) => e.slug), SLUG_ENCERRADO];
  const blocoEtapas = lista
    .map(
      (e, i) =>
        `${i + 1}. slug=${e.slug}\n   cumprida quando: ${e.criterio}` +
        (e.perguntaPendente ? `\n   pergunta auxiliar: ${e.perguntaPendente}` : ''),
    )
    .join('\n');

  const conversa = formatarHistoricoClassificador(historico);
  const prompt = [
    'Você classifica em qual etapa do funil o cliente está AGORA.',
    'As etapas estão em ORDEM. A etapa atual é a PRIMEIRA ainda NÃO cumprida.',
    'O campo "criterio" diz quando a etapa JÁ FOI CUMPRIDA (o cliente já deu aquela resposta/dado).',
    'Se o critério estiver escrito como instrução ("pergunte o nome; se já respondeu, siga"), interprete: cumprida quando o cliente já informou aquele dado.',
    'Perguntar não cumpre a etapa. Só a resposta do cliente cumpre.',
    `Se TODAS já foram cumpridas (funil concluído, transferido a humano, cliente desqualificado), devolva {"slug":"${SLUG_ENCERRADO}"}.`,
    'Não use o nome da etapa. Não procure a pergunta literal. Verifique o histórico.',
    'Se o cliente mudou de assunto mas ainda não deu o dado da etapa, essa etapa continua atual.',
    'Responda APENAS JSON: {"slug":"..."} com um destes valores:',
    permitidos.map((s) => `- ${s}`).join('\n'),
    '',
    'ETAPAS:',
    blocoEtapas,
    '',
    'CONVERSA:',
    conversa || '(sem mensagens)',
  ].join('\n');

  const modelo = agentConfig.pendingAnalysisModel || 'gpt-4o-mini';

  try {
    const body = {
      model: modelo,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responda apenas JSON válido. Sem markdown.' },
        { role: 'user', content: prompt },
      ],
    };
    if (supportsCustomTemperature(modelo)) body.temperature = 0;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentConfig.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);

    const texto = String(json.choices?.[0]?.message?.content || '').trim();
    const promptTokens = Number(json.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(json.usage?.completion_tokens ?? 0);
    const tot = Number(json.usage?.total_tokens ?? 0) || promptTokens + completionTokens;
    const parsed = extrairJson(texto);
    const bruto = String(parsed?.slug || '').trim();
    const slug = permitidos.includes(bruto) ? bruto : null;

    if (!slug) {
      logger.warn('Follow-up etapas: slug inválido', { bruto: bruto || null });
      return {
        slug: null,
        falhou: true,
        promptTokens,
        completionTokens,
        creditos: computeTokenCredits(tot, modelo),
        modelo,
      };
    }

    return {
      slug,
      falhou: false,
      promptTokens,
      completionTokens,
      creditos: computeTokenCredits(tot, modelo),
      modelo,
    };
  } catch (err) {
    logger.warn('Follow-up etapas: falha ao classificar', { message: err.message });
    return { slug: null, falhou: true, promptTokens: 0, completionTokens: 0, creditos: 0, modelo };
  }
}
