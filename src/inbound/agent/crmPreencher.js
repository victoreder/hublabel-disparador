import { logger } from '../../logger.js';

function formatHistory(history) {
  return (history ?? [])
    .map((m) => `${m.role === 'assistant' ? 'Agente' : 'Cliente'}: ${m.content}`)
    .join('\n');
}

function buildSchema(dados) {
  const properties = {};
  const required = [];

  if (dados.observacoes === true) {
    properties.observacoes = {
      type: 'string',
      description: dados.instrucaoObservacoes || 'Resumo relevante da conversa para o card',
    };
    required.push('observacoes');
  }

  if (dados.valor === true) {
    properties.valor = {
      type: 'number',
      description: dados.instrucaoValor || 'Valor numérico da oportunidade (apenas número, ex: 1500.50)',
    };
    required.push('valor');
  }

  if (dados.tarefa === true) {
    properties.tarefaTexto = {
      type: 'string',
      description: dados.instrucaoTarefa || 'Descrição da tarefa a criar no card',
    };
    properties.tarefaPrazo = {
      type: 'string',
      description:
        (dados.instrucaoTarefaData
          ? `${dados.instrucaoTarefaData}. `
          : '') +
        'Retorne a data no formato YYYY-MM-DD (ex: 2026-05-10). Se a instrução for relativa (amanhã, próxima segunda), calcule a data absoluta a partir de HOJE.',
    };
    required.push('tarefaTexto', 'tarefaPrazo');
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

function buildPrompt({ history, userMessage, respostaAgente, dados, textoContexto }) {
  const partes = [
    'Analise a conversa e preencha os campos do CRM conforme as instruções de cada campo.',
    'Use apenas informações presentes na conversa. Se não houver dado suficiente, inferir o mínimo razoável ou deixar breve.',
    'Para valor, retorne apenas número (sem R$, sem texto). Use ponto como decimal.',
    '',
    '## Histórico da conversa',
    formatHistory(history) || '(sem histórico anterior)',
  ];

  if (userMessage) {
    partes.push('', '## Última mensagem do cliente', userMessage);
  }

  if (textoContexto || respostaAgente) {
    partes.push('', '## Resposta atual do agente', textoContexto || stripActionMarkers(respostaAgente));
  }

  partes.push('', '## Campos a preencher');

  if (dados.observacoes === true) {
    partes.push(`- observacoes: ${dados.instrucaoObservacoes || 'Resumo da conversa'}`);
  }
  if (dados.valor === true) {
    partes.push(`- valor: ${dados.instrucaoValor || 'Valor total da oportunidade'}`);
  }
  if (dados.tarefa === true) {
    partes.push(`- tarefaTexto: ${dados.instrucaoTarefa || 'Tarefa a realizar'}`);
    partes.push(
      `- tarefaPrazo: ${dados.instrucaoTarefaData || dados.instrucaoTarefaPrazo || 'Prazo da tarefa'} — SEMPRE no formato YYYY-MM-DD`,
    );
  }

  return partes.join('\n');
}

function stripActionMarkers(text) {
  return String(text || '').replace(/\[\[acao:[\s\S]*?\]\]/g, '').trim();
}

function parseValor(valor) {
  if (valor == null || valor === '') return null;
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  const raw = String(valor).replace(/[^\d,.-]/g, '').trim();
  if (!raw) return null;
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export async function gerarPreenchimentoCrm({ agentConfig, agente, history, userMessage, respostaAgente, dados, textoContexto }) {
  const schema = buildSchema(dados);
  if (!schema.required.length) {
    return { observacoes: null, valor: null, tarefaTexto: null, tarefaPrazo: null };
  }

  const prompt = buildPrompt({ history, userMessage, respostaAgente, dados, textoContexto });

  const body = {
    model: agente.modelo || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você extrai dados estruturados de conversas de atendimento para preencher um CRM. Responda somente JSON válido conforme o schema.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'crm_preencher',
        strict: true,
        schema,
      },
    },
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentConfig.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || 'Falha ao gerar preenchimento CRM');
  }

  let parsed;
  try {
    parsed = JSON.parse(json.choices?.[0]?.message?.content || '{}');
  } catch (error) {
    logger.warn('crm-preencher: JSON inválido da OpenAI', { message: error.message });
    parsed = {};
  }

  return {
    observacoes: parsed.observacoes ?? null,
    valor: parseValor(parsed.valor),
    tarefaTexto: parsed.tarefaTexto ?? null,
    tarefaPrazo: parsed.tarefaPrazo ?? null,
    totalTokens: Number(json.usage?.total_tokens ?? 0),
  };
}
