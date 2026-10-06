import { HttpError } from '../meta/httpError.js';
import { fetchConfigIaApiKey, openAiChatCompletions, openAiResponsesText } from './openai.js';

const MODELO_PAGINA_VENDAS = process.env.OPENAI_MODEL_PAGINA_VENDAS?.trim() || 'gpt-5.3-codex';

const PROMPT_CRIAR_INSTRUCAO = `<modo>criar</modo>

<objetivo>
Gerar uma instrução detalhada e humanizada para um agente de IA que realiza atendimento no WhatsApp, com foco em triagem, qualificação e interação natural. O agente deve evitar perguntas fechadas, usar mensagens curtas, incentivar sempre a continuidade da conversa e demonstrar empatia em todas as interações. Assegure que o agente compreenda o contexto do usuário e adapte as respostas, promovendo uma experiência personalizada a cada contato.
</objetivo>

<processo_de_geracao>
Com base nas respostas, gere uma instrução clara, funcional e humanizada para o agente de IA. A instrução deve ser totalmente formatada em markdown, com mensagens curtas, linguagem empática, perguntas abertas, respostas para objeções, perguntas frequentes, coleta de dados, qualificação de leads, restrições e horário de atendimento.
</processo_de_geracao>

<regras_gerais>
- Sempre utilize formato markdown.
- Sempre utilize respostas curtas de até 3 linhas.
- Evite perguntas fechadas.
- Use emojis de forma moderada.
- Adapte-se ao ritmo da conversa.
</regras_gerais>`;

/** POST /testar-openai — "ping" na OpenAI com a chave salva; devolve a resposta da OpenAI. */
export async function testarOpenAi() {
  const apiKey = await fetchConfigIaApiKey();
  return openAiChatCompletions({
    apiKey,
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
  });
}

/** POST /criar-instrucao — gera a instrução do agente IA a partir do questionário. */
export async function criarInstrucao(body = {}) {
  const respostas = String(body.respostas ?? '').replaceAll('"', "'");
  if (!respostas.trim()) throw new HttpError('respostas é obrigatório', 400);

  const apiKey = await fetchConfigIaApiKey();
  const instrucao = await openAiResponsesText({
    apiKey,
    body: {
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: PROMPT_CRIAR_INSTRUCAO },
        { role: 'user', content: respostas },
      ],
    },
  });
  return { instrucao };
}

/** POST /gerarmensagem-ia — gera N variações de mensagem para os disparos. */
export async function gerarMensagensIa(body = {}) {
  const quantidade = Number.parseInt(body.quantidadeMensagens, 10);
  if (!Number.isFinite(quantidade) || quantidade < 1 || quantidade > 50) {
    throw new HttpError('quantidadeMensagens deve ser um número entre 1 e 50', 400);
  }
  const exemplos = Array.isArray(body.variacoesMensagens)
    ? body.variacoesMensagens.join(', ')
    : String(body.variacoesMensagens ?? '');

  const prompt =
    'Você é um copywriter especialista em mensagens de Whatsapp, preciso que você gere ' +
    quantidade +
    ' mensagens novas, seguindo como modelo esses exemplos: ' +
    exemplos +
    '. E essas instrucoes adicionais: ' +
    String(body.instrucoesAdicionais ?? '') +
    '. REGRAS: Não utilize emojis, a não ser que seja pedido. Não invente informações, apenas o que foi informado pelo usuário, toda chamada de interação na mensagem, deve ser para responder a mensagem';

  const apiKey = await fetchConfigIaApiKey();
  const texto = await openAiResponsesText({
    apiKey,
    body: {
      model: 'gpt-4.1-mini',
      input: [{ role: 'user', content: prompt }],
      text: {
        format: {
          type: 'json_schema',
          name: 'mensagens_whatsapp',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              mensagens: {
                type: 'array',
                items: { type: 'string', description: 'Mensagens' },
                minItems: quantidade,
                maxItems: quantidade,
              },
            },
            required: ['mensagens'],
            additionalProperties: false,
          },
        },
      },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(texto);
  } catch {
    throw new HttpError('OpenAI retornou um JSON inválido', 502);
  }
  return { mensagens: Array.isArray(parsed?.mensagens) ? parsed.mensagens : [] };
}

/** POST /personalizar-pagina — IA reescreve o HTML da página de vendas conforme a instrução. */
export async function personalizarPaginaIa(body = {}) {
  const html = String(body.html ?? '');
  const instrucao = String(body.instrucao ?? '').trim();
  if (!html.trim()) throw new HttpError('html é obrigatório', 400);
  if (!instrucao) throw new HttpError('instrucao é obrigatória', 400);

  const apiKey = await fetchConfigIaApiKey();
  const resposta = await openAiResponsesText({
    apiKey,
    body: {
      model: MODELO_PAGINA_VENDAS,
      input: [
        {
          role: 'system',
          content:
            'Esse é código de html de uma página de vendas, altere o código seguindo as intruções do usuário e retorne todo o código completo, com as alterações feitas\n\n' +
            'REGRA: JAMAIS SEJA PREGUIÇOSO OU TENTE ECONOMIZAR, VOCÊ DEVE RESPONDER O CÓDIGO COMPLETO ABAIXO, COM OS AJUSTES FEITOS\n\n' +
            html,
        },
        { role: 'user', content: instrucao },
      ],
    },
  });
  return { resposta };
}
