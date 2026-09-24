import {
  abrirAtendimentoHumano,
  notificarHumanoWhatsapp,
} from '../../supabase.js';

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

  // Produtos também são vetorizados; agentes antigos podem ter `conhecimento` nulo.
  if (agente?.id) {
    tools.push({
      type: 'function',
      function: {
        name: 'consultar_conhecimento',
        description:
          'Consulte os conhecimentos e produtos cadastrados do agente. Use obrigatoriamente para perguntas sobre produtos, preços, características, disponibilidade, links, fotos ou vídeos. Responda somente com os dados encontrados.',
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
    tools.push({
      type: 'function',
      function: {
        name: 'NOTIFICAR_HUMANO',
        description: 'ative essa ferramenta de acordo com as instrucoes',
        parameters: {
          type: 'object',
          properties: {
            mensagem: { type: 'string', description: 'mensagem para enviar pro usuario' },
          },
          required: ['mensagem'],
        },
      },
    });
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
    return JSON.stringify({
      encontrado: docs.length > 0,
      quantidade: docs.length,
      documentos: docs,
      instrucao_para_agente:
        docs.length > 0
          ? 'Responda diretamente com os dados exatos do primeiro documento, inclusive nome, descrição e preço. Não escreva informações gerais que não estejam nos documentos. Para enviar uma mídia encontrada, use [nome (image)](URL) ou [nome (video)](URL), com dois enters antes e depois.'
          : 'Nenhum conhecimento vinculado foi encontrado. Informe que essa informação não está cadastrada e não invente uma resposta geral.',
    });
  }

  if (name === 'ABRIR_ATENDIMENTO') {
    await abrirAtendimentoHumano({
      telefone: job.telefone,
      conexaoId: job.conexaoId,
    });
    return JSON.stringify({ success: true, statusAtendimento: 'aberto', pausado: true });
  }

  if (name === 'NOTIFICAR_HUMANO') {
    const whatsapp = agente?.notificarHumano?.itens?.[0]?.whatsapp;
    if (!whatsapp) {
      return JSON.stringify({ success: false, error: 'WhatsApp de notificação não configurado' });
    }
    await notificarHumanoWhatsapp({
      job,
      whatsappDestino: whatsapp,
      mensagem: args.mensagem,
    });
    return JSON.stringify({ success: true });
  }

  if (name === 'REQUISICAO_DINAMICA') {
    const result = await dynamicHttpRequest(args);
    return JSON.stringify(result);
  }

  return JSON.stringify({ success: false, error: `Ferramenta desconhecida: ${name}` });
}
