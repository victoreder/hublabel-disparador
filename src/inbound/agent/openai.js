import { logger } from '../../logger.js';
import { supportsCustomTemperature } from './config.js';
import { executeTool, buildToolDefinitions } from './tools.js';
import { searchKnowledge } from './rag.js';

export async function runAgentChat({
  agentConfig,
  job,
  agente,
  systemPrompt,
  history,
  userMessage,
}) {
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

    return {
      content: message.content?.trim() || '',
      toolsExecuted,
      totalTokens,
    };
  }

  throw new Error('Limite de rodadas de ferramentas do agente atingido');
}
