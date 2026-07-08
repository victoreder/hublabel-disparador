import { logger } from '../../logger.js';
import {
  adicionarEtiquetaContato,
  atualizarCampoPersonalizado,
  buscarAtendenteAleatorio,
  buscarAtendenteAleatorioSetor,
  buscarCardContato,
  moverCardCrm,
  preencherCardCrm,
  removerEtiquetaContato,
  transferirConversaHumano,
  transferirConversaSetor,
  transferirConversaAgenteIA,
} from '../../supabase.js';
import { gerarPreenchimentoCrm } from './crmPreencher.js';
import { executeNotificarHumano } from './notifyHuman.js';
import { resolveMediaMarkdown } from './parseActions.js';
import { classifyChunk } from './parseResponse.js';
import { sendAgentChunk } from './sendReply.js';

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function dynamicHttpRequest({ url, method, headers, body, queryParams }) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (!url?.trim()) {
    return { success: false, error: "Campo 'url' é obrigatório." };
  }
  if (!VALID_METHODS.has(upperMethod)) {
    return { success: false, error: `Método '${upperMethod}' inválido.` };
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
    return { success: response.ok, status: response.status, data };
  } catch (error) {
    return { success: false, status: null, error: error.message, data: null };
  }
}

function normalizeTipo(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  if (t === 'crm-movimentacao') return 'crm-mover';
  return t;
}

async function resolveAtendenteId(dados, { contaId, setorId = null }) {
  const modo = String(dados?.atendenteModo || 'nenhum').toLowerCase();

  if (modo === 'nenhum' || modo === '') return null;
  if (modo === 'especifico') {
    const id = String(dados?.atendenteId || '').trim();
    return id || null;
  }
  if (modo === 'aleatorio') {
    if (setorId) return buscarAtendenteAleatorioSetor(setorId, contaId);
    return buscarAtendenteAleatorio(contaId);
  }
  return null;
}

async function executarEnviarMidia(acao, ctx) {
  const arquivoId = String(acao.dados?.arquivoId || '').trim();
  const arquivoInfo = ctx.arquivoMap?.get(arquivoId);
  const markdown = resolveMediaMarkdown(arquivoInfo);

  if (!markdown) {
    logger.warn('enviar-midia: arquivo não encontrado nas instruções', { arquivoId });
    return { success: false, error: 'Arquivo não encontrado nas instruções' };
  }

  await sendAgentChunk(ctx.job, { kind: classifyChunk(markdown), text: markdown }, ctx.agentConfig);
  return { success: true, arquivoId };
}

async function executarAdicionarEtiqueta(acao, ctx) {
  const etiquetaId = Number(acao.dados?.etiquetaId);
  if (!etiquetaId || !ctx.job.contatoId) {
    return { success: false, error: 'etiquetaId ou contatoId ausente' };
  }
  await adicionarEtiquetaContato({
    contatoId: ctx.job.contatoId,
    etiquetaId,
    contaId: ctx.job.contaId,
  });
  return { success: true, etiquetaId };
}

async function executarRemoverEtiqueta(acao, ctx) {
  const etiquetaId = Number(acao.dados?.etiquetaId);
  if (!etiquetaId || !ctx.job.contatoId) {
    return { success: false, error: 'etiquetaId ou contatoId ausente' };
  }
  await removerEtiquetaContato({ contatoId: ctx.job.contatoId, etiquetaId });
  return { success: true, etiquetaId };
}

async function executarCampoPersonalizado(acao, ctx) {
  const campoId = Number(acao.dados?.campoId);
  const valor = acao.dados?.valor;
  if (!campoId || !ctx.job.contatoId) {
    return { success: false, error: 'campoId ou contatoId ausente' };
  }
  await atualizarCampoPersonalizado({
    contatoId: ctx.job.contatoId,
    campoId,
    contaId: ctx.job.contaId,
    valor: valor != null ? String(valor) : '',
  });
  return { success: true, campoId };
}

async function executarTransferirAtendente(acao, ctx) {
  const atendenteId = await resolveAtendenteId(acao.dados, { contaId: ctx.job.contaId });
  await transferirConversaHumano({
    conversaId: ctx.job.conversaId,
    atendenteId,
    pausado: true,
    statusAtendimento: 'aberto',
  });
  return { success: true, atendenteId };
}

async function executarNotificarHumano(acao, ctx) {
  try {
    const resultado = await executeNotificarHumano({
      job: ctx.job,
      agente: ctx.agente,
      args: acao.dados ?? {},
    });
    return resultado;
  } catch (error) {
    logger.warn('notificar-humano falhou — ignorado', { message: error.message });
    return { success: true, ignorado: true, error: error.message };
  }
}

async function executarTransferirSetor(acao, ctx) {
  const setorId = Number(acao.dados?.setorId);
  if (!setorId) return { success: false, error: 'setorId ausente' };

  const atendenteId = await resolveAtendenteId(acao.dados, {
    contaId: ctx.job.contaId,
    setorId,
  });

  await transferirConversaSetor({
    conversaId: ctx.job.conversaId,
    setorId,
    atendenteId,
    pausado: Boolean(atendenteId),
    statusAtendimento: atendenteId ? 'aberto' : undefined,
  });

  return { success: true, setorId, atendenteId };
}

async function executarTransferirAgenteIA(acao, ctx) {
  const agenteId = Number(acao.dados?.agenteId);
  if (!agenteId) return { success: false, error: 'agenteId ausente' };

  await transferirConversaAgenteIA({
    conversaId: ctx.job.conversaId,
    agenteId,
  });

  ctx.job.agenteId = agenteId;
  return { success: true, agenteId };
}

async function executarCrmMover(acao, ctx) {
  const quadroId = Number(acao.dados?.quadroId);
  const etapaId = Number(acao.dados?.etapaId);
  if (!quadroId || !etapaId || !ctx.job.contatoId) {
    return { success: false, error: 'quadroId, etapaId ou contatoId ausente' };
  }

  const card = await buscarCardContato({ contatoId: ctx.job.contatoId, quadroId });
  if (!card?.id) {
    return { success: false, error: 'Card CRM não encontrado para o contato' };
  }

  await moverCardCrm({ cardId: card.id, etapaId, quadroId });
  return { success: true, cardId: card.id, etapaId };
}

async function executarCrmPreencher(acao, ctx) {
  const dados = acao.dados ?? {};
  const quadroId = Number(dados.quadroId) || null;

  let card = null;
  if (quadroId && ctx.job.contatoId) {
    card = await buscarCardContato({ contatoId: ctx.job.contatoId, quadroId });
  } else if (ctx.job.contatoId) {
    card = await buscarCardContato({ contatoId: ctx.job.contatoId });
  }

  if (!card?.id) {
    return { success: false, error: 'Card CRM não encontrado' };
  }

  const preenchimento = await gerarPreenchimentoCrm({
    agentConfig: ctx.agentConfig,
    agente: ctx.agente,
    history: ctx.history ?? [],
    userMessage: ctx.userMessage ?? null,
    respostaAgente: ctx.respostaAgente ?? null,
    dados,
    textoContexto: ctx.textoContexto,
  });

  await preencherCardCrm({
    cardId: card.id,
    observacoes: dados.observacoes === true ? preenchimento.observacoes : null,
    valor: dados.valor === true ? preenchimento.valor : null,
    criarTarefa: dados.tarefa === true,
    textoTarefa: preenchimento.tarefaTexto,
    prazoTarefa: preenchimento.tarefaPrazo,
  });

  return {
    success: true,
    cardId: card.id,
    preenchimento,
    tokensExtras: preenchimento.totalTokens ?? 0,
  };
}

async function executarFerramentaHttp(acao, ctx) {
  const httpIndex = Number(acao.dados?.httpIndex ?? 0);
  const itens = ctx.agente?.requisicaoHTTP?.itens ?? [];
  const item = itens[httpIndex];

  if (!item) {
    return { success: false, error: `Ferramenta HTTP índice ${httpIndex} não encontrada` };
  }

  const result = await dynamicHttpRequest({
    url: item.url,
    method: item.method || item.metodo || 'GET',
    headers: item.headers ?? {},
    body: item.body ?? item.corpo ?? {},
    queryParams: item.queryParams ?? item.params ?? {},
  });

  return result;
}

const EXECUTORES = {
  'enviar-midia': executarEnviarMidia,
  'adicionar-etiqueta': executarAdicionarEtiqueta,
  'remover-etiqueta': executarRemoverEtiqueta,
  'campo-personalizado': executarCampoPersonalizado,
  'transferir-atendente': executarTransferirAtendente,
  'notificar-humano': executarNotificarHumano,
  'transferir-setor': executarTransferirSetor,
  'transferir-agente-ia': executarTransferirAgenteIA,
  'crm-mover': executarCrmMover,
  'crm-preencher': executarCrmPreencher,
  'ferramenta-http': executarFerramentaHttp,
};

export async function executeAgentAction(acao, ctx) {
  const tipo = normalizeTipo(acao?.tipo);
  const executor = EXECUTORES[tipo];

  if (!executor) {
    logger.warn('Ação desconhecida', { tipo: acao?.tipo });
    return { success: false, error: `Ação desconhecida: ${acao?.tipo}` };
  }

  try {
    const resultado = await executor(acao, ctx);
    logger.info('Ação executada', { tipo, conversaId: ctx.job?.conversaId, resultado });
    return resultado;
  } catch (error) {
    logger.warn('Falha ao executar ação — ignorado, agente continua', {
      tipo,
      conversaId: ctx.job?.conversaId,
      message: error.message,
    });
    return { success: false, error: error.message, ignorado: true };
  }
}