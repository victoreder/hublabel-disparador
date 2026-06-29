import { logger } from '../../logger.js';
import {
  adicionarEtiquetaContato,
  atualizarCampoPersonalizado,
  buscarAtendenteAleatorio,
  buscarAtendenteAleatorioSetor,
  buscarCardContato,
  criarCardCrm,
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

function normalizeTipo(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  if (t === 'crm-movimentacao') return 'crm-mover';
  return t;
}

function telefoneFromJob(job) {
  return String(job?.telefone || '')
    .replace('@s.whatsapp.net', '')
    .replace(/\D/g, '');
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
      args: {
        mensagem: acao.dados?.mensagem,
        indice: acao.dados?.indice ?? 0,
      },
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

async function aplicarPreenchimentoCrmCard({ dados, card, ctx }) {
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
    cardId: card.id,
    preenchimento,
    tokensExtras: preenchimento.totalTokens ?? 0,
  };
}

async function executarCrmMover(acao, ctx) {
  const dados = acao.dados ?? {};
  const quadroId = Number(dados.quadroId);
  const etapaId = Number(dados.etapaId);
  if (!quadroId || !etapaId || !ctx.job.contatoId) {
    return { success: false, error: 'quadroId, etapaId ou contatoId ausente' };
  }

  const card = await buscarCardContato({ contatoId: ctx.job.contatoId, quadroId });
  if (!card?.id) {
    return { success: false, error: 'Card CRM não encontrado para o contato' };
  }

  await moverCardCrm({ cardId: card.id, etapaId, quadroId });
  return { success: true, cardId: card.id, etapaId, modo: 'mover' };
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

  const resultado = await aplicarPreenchimentoCrmCard({ dados, card, ctx });

  return {
    success: true,
    modo: 'preencher',
    ...resultado,
  };
}

async function executarCrmCriar(acao, ctx) {
  const dados = acao.dados ?? {};
  const quadroId = Number(dados.quadroId);
  const etapaId = Number(dados.etapaId);

  if (!quadroId || !etapaId || !ctx.job.contatoId) {
    return { success: false, error: 'quadroId, etapaId ou contatoId ausente' };
  }

  let card = await buscarCardContato({ contatoId: ctx.job.contatoId, quadroId });
  let cardCriado = false;

  if (!card?.id) {
    const telefone = telefoneFromJob(ctx.job);
    card = await criarCardCrm({
      contatoId: ctx.job.contatoId,
      quadroId,
      etapaId,
      nome: ctx.job.nomeContato || telefone,
      contato: telefone,
    });
    cardCriado = true;
  }

  const temPreenchimento =
    dados.observacoes === true || dados.valor === true || dados.tarefa === true;

  let preenchimentoResultado = null;
  if (temPreenchimento) {
    preenchimentoResultado = await aplicarPreenchimentoCrmCard({ dados, card, ctx });
  }

  return {
    success: true,
    modo: 'criar',
    cardId: card.id,
    cardCriado,
    ...preenchimentoResultado,
  };
}

async function executarCrm(acao, ctx) {
  const modo = String(acao.dados?.modo || '').toLowerCase();

  if (modo === 'criar') return executarCrmCriar(acao, ctx);
  if (modo === 'mover') return executarCrmMover(acao, ctx);
  if (modo === 'preencher') return executarCrmPreencher(acao, ctx);

  return { success: false, error: `modo CRM inválido: ${modo || '(vazio)'}` };
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
  crm: executarCrm,
  'crm-mover': executarCrmMover,
  'crm-preencher': executarCrmPreencher,
};

export async function executeAgentAction(acao, ctx) {
  const tipo = normalizeTipo(acao?.tipo);

  if (tipo === 'ferramenta-http') {
    return { success: true, ignorado: true, motivo: 'ferramenta_http_via_tool_openai' };
  }

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
