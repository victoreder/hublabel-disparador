import {
  abrirAtendimentoHumano,
} from '../../supabase.js';
import { executeNotificarHumano } from './notifyHuman.js';

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function dynamicHttpRequest({ url, method, headers, body, queryParams }) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (!url?.trim()) {
    return { success: false, error: "Campo 'url' é obrigatório." };
  }
  if (!VALID_METHODS.has(upperMethod)) {
    return { success: false, error: `Método '${upperMethod}' inválido.` };
  }

  if (['POST', 'PUT', 'PATCH'].includes(upperMethod)) {
    if (!headers || typeof headers !== 'object' || !Object.keys(headers).length) {
      return { success: false, error: `Para método ${upperMethod}, o campo 'headers' é obrigatório.` };
    }
    if (!body || typeof body !== 'object' || !Object.keys(body).length) {
      return { success: false, error: `Para método ${upperMethod}, o campo 'body' é obrigatório.` };
    }
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

export function buildToolDefinitions(job, agente) {
  const tools = [];

  if (agente?.conhecimento) {
    tools.push({
      type: 'function',
      function: {
        name: 'consultar_conhecimento',
        description:
          'Quando precisar de alguma informação que não saiba, ou for solicitada para consultar no conhecimento, utilize essa ferramenta',
        parameters: {
          type: 'object',
          properties: {
            pergunta: { type: 'string', description: 'Pergunta para buscar no conhecimento' },
          },
          required: ['pergunta'],
        },
      },
    });
  }

  if (agente?.abrirAtendimento?.ativo === true) {
    tools.push({
      type: 'function',
      function: {
        name: 'ABRIR_ATENDIMENTO',
        description: 'ative essa ferramenta de acordo com as instrucoes',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    });
  }

  if (agente?.notificarHumano?.ativo === true) {
    // Evita tool + [[acao:notificar-humano]] no mesmo turno
    const usaAcaoMarcador = /\[\[acao:[\s\S]*?notificar-humano/i.test(String(agente?.instrucoes || ''));
    if (!usaAcaoMarcador) {
      tools.push({
        type: 'function',
        function: {
          name: 'NOTIFICAR_HUMANO',
          description: 'Notifica humanos configurados conforme as instruções.',
          parameters: {
            type: 'object',
            properties: {
              mensagem: { type: 'string', description: 'mensagem para enviar aos humanos' },
              indice: { type: 'integer', description: 'índice do item em notificarHumano.itens' },
            },
            required: ['mensagem'],
          },
        },
      });
    }
  }

  if (agente?.requisicaoHTTP?.ativo === true) {
    tools.push({
      type: 'function',
      function: {
        name: 'REQUISICAO_DINAMICA',
        description: 'Chame essa ferramenta quando na instrucao for pedido para chamar qualquer ferramenta',
        parameters: {
          type: 'object',
          required: ['url', 'method', 'headers', 'body'],
          properties: {
            url: { type: 'string' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'object', additionalProperties: true },
            queryParams: { type: 'object', additionalProperties: true },
          },
        },
      },
    });
  }

  return tools;
}

export async function executeTool(name, args, { job, agente, agentConfig, searchKnowledge }) {
  if (name === 'consultar_conhecimento') {
    const docs = await searchKnowledge(agentConfig, agente.id, args.pergunta);
    return JSON.stringify({ documentos: docs });
  }

  if (name === 'ABRIR_ATENDIMENTO') {
    await abrirAtendimentoHumano({
      telefone: job.telefone,
      conexaoId: job.conexaoId,
    });
    return JSON.stringify({ success: true, statusAtendimento: 'aberto', pausado: true });
  }

  if (name === 'NOTIFICAR_HUMANO') {
    const resultado = await executeNotificarHumano({
      job,
      agente,
      args,
      redisUrl: agentConfig?.redisUrl,
    });
    return JSON.stringify(resultado);
  }

  if (name === 'REQUISICAO_DINAMICA') {
    const result = await dynamicHttpRequest(args);
    return JSON.stringify(result);
  }

  return JSON.stringify({ success: false, error: `Ferramenta desconhecida: ${name}` });
}
