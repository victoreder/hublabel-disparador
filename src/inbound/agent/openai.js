import { logger } from '../../logger.js';
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

  let rounds = 0;
  while (rounds < agentConfig.maxToolRounds) {
    rounds += 1;

    const body = {
      model: agente.modelo || 'gpt-4o-mini',
      messages,
    };

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
      throw new Error(json?.error?.message || 'Falha no chat OpenAI');
    }

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

        let toolResult;
        try {
          toolResult = await executeTool(call.function?.name, args, {
            job,
            agente,
            agentConfig,
            searchKnowledge,
          });
        } catch (error) {
          logger.warn('Falha em tool do agente', {
            tool: call.function?.name,
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

    return message.content?.trim() || '';
  }

  throw new Error('Limite de rodadas de ferramentas do agente atingido');
}
