import { parseAgentOutputWithActions } from './parseActions.js';

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function parseActionsFromInstrucoes(instrucoes) {
  return parseAgentOutputWithActions(instrucoes)
    .filter((segment) => segment.type === 'action')
    .map((segment) => segment.content);
}

export function extractFerramentasHttpFromInstrucoes(instrucoes) {
  const segments = parseAgentOutputWithActions(instrucoes);
  const results = [];

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.type !== 'action') continue;
    if (String(seg.content?.tipo || '').toLowerCase() !== 'ferramenta-http') continue;

    const httpIndex = Number(seg.content.dados?.httpIndex ?? 0);
    const nome = String(seg.content.dados?.nome || `HTTP ${httpIndex}`).trim();

    const contextParts = [];
    for (let j = i - 1; j >= 0 && contextParts.length < 2; j -= 1) {
      if (segments[j].type === 'text') contextParts.unshift(segments[j].content);
    }

    results.push({
      httpIndex,
      nome,
      contexto: contextParts.join('\n').trim(),
      dados: seg.content.dados ?? {},
    });
  }

  return results;
}

export function agenteTemFerramentaHttpNasInstrucoes(agente) {
  const fromInstrucoes = extractFerramentasHttpFromInstrucoes(agente?.instrucoes).length > 0;
  if (fromInstrucoes) return true;

  // fallback: chip na instrução sem parse perfeito mas requisicaoHTTP configurado
  return (
    String(agente?.instrucoes || '').includes('ferramenta-http') &&
    (agente?.requisicaoHTTP?.itens ?? []).some((item) => item?.url)
  );
}

function resolveHttpItens(agente, httpActions) {
  const itens = agente?.requisicaoHTTP?.itens ?? [];
  if (httpActions.length) {
    return httpActions
      .map((action) => {
        const item = itens[action.httpIndex];
        if (!item?.url) return null;
        return { ...action, item };
      })
      .filter(Boolean);
  }

  return itens
    .map((item, httpIndex) => (item?.url ? { httpIndex, nome: item.nome || item.instrucao, item } : null))
    .filter(Boolean);
}

export function buildFerramentaHttpToolSchema(agente) {
  const httpActions = extractFerramentasHttpFromInstrucoes(agente?.instrucoes);
  const resolved = resolveHttpItens(agente, httpActions);

  if (!resolved.length) return null;

  const linhas = resolved.map((entry) => {
    const quando = entry.contexto || entry.item?.instrucao || entry.nome;
    return `- httpIndex ${entry.httpIndex} (${entry.nome}): ${quando}`;
  });

  const indices = [...new Set(resolved.map((e) => e.httpIndex))];

  const httpIndexSchema =
    indices.length === 1
      ? {
          type: 'integer',
          description: `Índice da ferramenta HTTP (${indices[0]}) conforme instruções`,
        }
      : {
          type: 'integer',
          enum: indices,
          description: 'Índice da ferramenta HTTP conforme instruções (campo httpIndex da ação)',
        };

  return {
    type: 'function',
    function: {
      name: 'ferramenta_http',
      description: [
        'Executa uma requisição HTTP configurada no agente. Use quando a condição nas instruções for atendida.',
        'Utilize o retorno (campo data) para compor sua resposta ao cliente.',
        'Ferramentas disponíveis:',
        ...linhas,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          httpIndex: httpIndexSchema,
          queryParams: {
            type: 'object',
            additionalProperties: true,
            description: 'Opcional: parâmetros de query para substituir/complementar os configurados',
          },
          body: {
            type: 'object',
            additionalProperties: true,
            description: 'Opcional: corpo JSON para substituir/complementar o configurado (POST/PUT/PATCH)',
          },
        },
        required: ['httpIndex'],
      },
    },
  };
}

export async function dynamicHttpRequest({ url, method, headers, body, queryParams }) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (!url?.trim()) {
    return { success: false, error: "Campo 'url' é obrigatório." };
  }
  if (!VALID_METHODS.has(upperMethod)) {
    return { success: false, error: `Método '${upperMethod}' inválido.` };
  }

  const targetUrl = new URL(url);
  if (queryParams && typeof queryParams === 'object') {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value != null) targetUrl.searchParams.set(key, String(value));
    }
  }

  const init = { method: upperMethod, headers: headers ?? undefined };
  if (!['GET', 'DELETE'].includes(upperMethod) && body != null) {
    init.headers = { 'Content-Type': 'application/json', ...headers };
    init.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(targetUrl.toString(), init);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text ? { message: text } : null;
    }
    return {
      success: response.ok,
      status: response.status,
      data,
    };
  } catch (error) {
    return { success: false, status: null, error: error.message, data: null };
  }
}

export async function executeFerramentaHttpTool(agente, args) {
  const httpIndex = Number(args?.httpIndex ?? 0);
  const itens = agente?.requisicaoHTTP?.itens ?? [];
  const item = itens[httpIndex];

  if (!item?.url) {
    return { success: false, error: `Ferramenta HTTP índice ${httpIndex} não encontrada ou sem URL` };
  }

  const body =
    args?.body && Object.keys(args.body).length
      ? { ...(item.body ?? item.corpo ?? {}), ...args.body }
      : item.body ?? item.corpo ?? undefined;

  const queryParams =
    args?.queryParams && Object.keys(args.queryParams).length
      ? { ...(item.queryParams ?? item.params ?? {}), ...args.queryParams }
      : item.queryParams ?? item.params ?? undefined;

  return dynamicHttpRequest({
    url: item.url,
    method: item.method || item.metodo || 'GET',
    headers: item.headers ?? {},
    body,
    queryParams,
  });
}
