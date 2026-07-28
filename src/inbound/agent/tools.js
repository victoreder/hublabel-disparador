import {
  abrirAtendimentoHumano,
} from '../../supabase.js';
import {
  applyHttpTemplates,
  dynamicHttpRequest,
  resolveHttpRequestConfig,
} from './httpRequest.js';
import { executeNotificarHumano } from './notifyHuman.js';

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
        description:
          'Executa a requisição HTTP configurada e DEVOLVE o JSON da resposta para você usar na mensagem ao usuário. Use httpIndex do item (0, 1, ...). Preencha body com as variáveis {{...}} coletadas. URL/método podem ser omitidos (usa o preset). Depois que receber o resultado, responda ao cliente com as informações de data.',
        parameters: {
          type: 'object',
          properties: {
            httpIndex: {
              type: 'integer',
              description: 'Índice do item em requisicaoHTTP.itens (padrão 0)',
            },
            url: { type: 'string', description: 'Opcional — sobrescreve a URL do preset' },
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              description: 'Opcional — sobrescreve o método do preset',
            },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Opcional — headers extras',
            },
            body: {
              type: 'object',
              additionalProperties: true,
              description: 'Body JSON com variáveis preenchidas',
            },
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
    const itens = agente?.requisicaoHTTP?.itens ?? [];
    const idx = Number(args?.httpIndex ?? 0);
    const item = itens[Number.isFinite(idx) ? idx : 0] || itens[0] || {};
    const resolved = applyHttpTemplates(resolveHttpRequestConfig(item, args || {}), { job });
    const result = await dynamicHttpRequest(resolved);
    const forAgent = {
      success: result.success,
      status: result.status,
      error: result.error || undefined,
      data: result.data,
      instrucao_para_agente:
        'Use success/status/data para responder ao usuário com as informações relevantes. Não invente dados que não estejam em data.',
    };
    let text = JSON.stringify(forAgent);
    if (text.length > 12_000) {
      forAgent.data = {
        _truncado: true,
        preview: text.slice(0, 10_000),
      };
      text = JSON.stringify(forAgent);
    }
    return text;
  }

  return JSON.stringify({ success: false, error: `Ferramenta desconhecida: ${name}` });
}
