import {
  abrirAtendimentoHumano,
  notificarHumanoWhatsapp,
} from '../../supabase.js';

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function agenteTemConhecimento(agente) {
  const conhecimento = agente?.conhecimento;
  if (conhecimento == null) return false;
  if (Array.isArray(conhecimento)) {
    return conhecimento.some(
      (item) =>
        item != null &&
        (Boolean(item.idUnico) ||
          Boolean(item.id) ||
          (typeof item === 'object' && Object.keys(item).length > 0)),
    );
  }
  if (typeof conhecimento === 'object') return Object.keys(conhecimento).length > 0;
  return Boolean(String(conhecimento).trim());
}

function getNotificarItens(agente) {
  return (agente?.notificarHumano?.itens ?? []).filter((item) => item?.whatsapp || item?.instrucoes);
}

function resolveWhatsappNotificacao(agente, whatsappArg) {
  const itens = getNotificarItens(agente);
  const permitidos = [...new Set(itens.map((i) => String(i.whatsapp || '').trim()).filter(Boolean))];

  if (!permitidos.length) return null;

  const informado = String(whatsappArg || '').trim();
  if (informado) {
    const match = permitidos.find((n) => n === informado || n.replace(/\D/g, '') === informado.replace(/\D/g, ''));
    return match ?? null;
  }

  if (permitidos.length === 1) return permitidos[0];
  return null;
}

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

  if (agenteTemConhecimento(agente)) {
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
    const itensNotificar = getNotificarItens(agente);
    const whatsapps = [...new Set(itensNotificar.map((i) => i.whatsapp).filter(Boolean))];

    if (whatsapps.length > 0) {
      const properties = {
        mensagem: { type: 'string', description: 'Mensagem para enviar ao humano' },
      };
      const required = ['mensagem'];

      if (whatsapps.length > 1) {
        properties.whatsapp = {
          type: 'string',
          enum: whatsapps,
          description:
            'WhatsApp do humano a notificar — escolha conforme as instruções de cada destino no prompt',
        };
        required.push('whatsapp');
      }

      tools.push({
        type: 'function',
        function: {
          name: 'NOTIFICAR_HUMANO',
          description:
            whatsapps.length > 1
              ? 'Notifique um humano via WhatsApp. Use o campo whatsapp para escolher o destino correto.'
              : 'ative essa ferramenta de acordo com as instrucoes',
          parameters: {
            type: 'object',
            properties,
            required,
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
    const whatsapp = resolveWhatsappNotificacao(agente, args.whatsapp);
    if (!whatsapp) {
      const itens = getNotificarItens(agente);
      const destinos = [...new Set(itens.map((i) => i.whatsapp).filter(Boolean))];
      return JSON.stringify({
        success: false,
        error:
          destinos.length > 1
            ? `Informe whatsapp entre os destinos configurados: ${destinos.join(', ')}`
            : 'WhatsApp de notificação não configurado',
      });
    }

    await notificarHumanoWhatsapp({
      job,
      whatsappDestino: whatsapp,
      mensagem: args.mensagem,
    });
    return JSON.stringify({ success: true, whatsapp });
  }

  if (name === 'REQUISICAO_DINAMICA') {
    const result = await dynamicHttpRequest(args);
    return JSON.stringify(result);
  }

  return JSON.stringify({ success: false, error: `Ferramenta desconhecida: ${name}` });
}
