import { abrirAtendimentoHumano } from '../../supabase.js';
import { logger } from '../../logger.js';

function agenteTemConhecimentoLocal(agente) {
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

export { agenteTemConhecimentoLocal as agenteTemConhecimento };

export function buildToolDefinitions(job, agente) {
  const tools = [];

  if (agenteTemConhecimentoLocal(agente)) {
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

  return JSON.stringify({ success: false, error: `Ferramenta desconhecida: ${name}` });
}
