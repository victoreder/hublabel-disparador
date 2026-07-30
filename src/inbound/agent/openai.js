import { logger } from '../../logger.js';
import { normalizeTipo } from './actions.js';
import { supportsCustomTemperature } from './config.js';
import { extractActionsFromText } from './parseActions.js';
import { executeTool, buildToolDefinitions } from './tools.js';
import { searchKnowledge } from './rag.js';

const HTTP_RESULT_MAX_CHARS = 12_000;

function buildHttpFollowUpMessage(results) {
  let payload = JSON.stringify(results, null, 2);
  if (payload.length > HTTP_RESULT_MAX_CHARS) {
    payload = `${payload.slice(0, HTTP_RESULT_MAX_CHARS)}\n...[truncado]`;
  }
  return [
    'Resultado da(s) requisição(ões) HTTP:',
    '```json',
    payload,
    '```',
    'Com base nesses dados, responda agora ao usuário de forma natural e útil.',
    'Use apenas informações presentes no JSON. Não invente.',
    'Não emita novamente [[acao:ferramenta-http]] para a mesma consulta.',
    'Não diga que "fez uma requisição/API" — fale só com as informações relevantes.',
  ].join('\n');
}

export async function runAgentChat({
  agentConfig,
  job,
  agente,
  systemPrompt,
  history,
  userMessage,
  signal,
}) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }

  const tools = buildToolDefinitions(job, agente);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const model = agente.modelo || 'gpt-4o-mini';
  const toolsExecuted = [];
  let totalTokens = 0;

  let rounds = 0;
  while (rounds < agentConfig.maxToolRounds) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    rounds += 1;

    const body = {
      model,
      messages,
    };

    if (supportsCustomTemperature(model)) {
      body.temperature = Number(agente.criatividade ?? 0.7);
    }

    if (tools.length) body.tools = tools;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentConfig.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json?.error?.message || 'Falha no chat OpenAI');
      error.code = json?.error?.code;
      error.status = response.status;
      throw error;
    }

    totalTokens += Number(json.usage?.total_tokens ?? 0);

    const choice = json.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error('OpenAI retornou resposta vazia');

    if (message.tool_calls?.length) {
      messages.push(message);
      for (const call of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }

        const toolName = call.function?.name;
        if (toolName) toolsExecuted.push(toolName);

        let toolResult;
        try {
          toolResult = await executeTool(toolName, args, {
            job,
            agente,
            agentConfig,
            searchKnowledge,
          });
        } catch (error) {
          logger.warn('Falha em tool do agente', {
            tool: toolName,
            message: error.message,
          });
          toolResult = JSON.stringify({ success: false, error: error.message });
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult,
        });
      }
      continue;
    }

    const content = message.content?.trim() || '';

    // Se o modelo emitiu [[acao:ferramenta-http]] em vez da tool, executa e devolve
    // o resultado para ele responder com os dados (mesmo ciclo do tool_calls).
    const httpActions = extractActionsFromText(content).filter(
      (acao) => normalizeTipo(acao?.tipo) === 'ferramenta-http',
    );
    if (
      httpActions.length &&
      !toolsExecuted.includes('REQUISICAO_DINAMICA') &&
      rounds < agentConfig.maxToolRounds
    ) {
      messages.push({ role: 'assistant', content: message.content || content });

      const results = [];
      for (const acao of httpActions) {
        try {
          const raw = await executeTool('REQUISICAO_DINAMICA', acao.dados || {}, {
            job,
            agente,
            agentConfig,
            searchKnowledge,
          });
          try {
            results.push(JSON.parse(raw));
          } catch {
            results.push({ success: false, error: 'Resposta HTTP inválida', raw });
          }
        } catch (error) {
          logger.warn('Falha ao executar HTTP via marcador [[acao:]]', {
            message: error.message,
          });
          results.push({ success: false, error: error.message });
        }
      }

      toolsExecuted.push('REQUISICAO_DINAMICA');
      messages.push({
        role: 'user',
        content: buildHttpFollowUpMessage(results),
      });

      logger.info('HTTP via [[acao:]] — resultado devolvido ao agente', {
        conversaId: job?.conversaId,
        qtd: results.length,
      });
      continue;
    }

    return {
      content,
      toolsExecuted,
      totalTokens,
    };
  }

  throw new Error('Limite de rodadas de ferramentas do agente atingido');
}
