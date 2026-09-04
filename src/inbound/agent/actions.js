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
import { cancelarFollowup } from './followup/index.js';
import {
  applyHttpTemplates,
  dynamicHttpRequest,
  resolveHttpRequestConfig,
} from './httpRequest.js';
import { executeNotificarHumano } from './notifyHuman.js';
import { extractActionsFromText } from './parseActions.js';
import { classifyChunk, normalizeMediaUrl } from './parseResponse.js';
import { normalizeMediaType } from './mediaType.js';
import { tryAcquireActionLock } from './redis.js';
import { sendAgentChunk } from './sendReply.js';

function normalizeTipo(tipo) {
  const t = String(tipo || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const aliases = {
    'crm-movimentacao': 'crm-mover',
    'crm_mover': 'crm-mover',
    'crm_preencher': 'crm-preencher',
    'crm_criar': 'crm-criar',
    'crm-criar-card': 'crm-criar',
    'atribuir-atendente': 'transferir-atendente',
    'atribuir_atendente': 'transferir-atendente',
    'transferir_atendente': 'transferir-atendente',
    'transferir-para-atendente': 'transferir-atendente',
    'abrir-atendimento': 'transferir-atendente',
    'notificar_humano': 'notificar-humano',
    'notificar-humanos': 'notificar-humano',
    'transferir_setor': 'transferir-setor',
    'transferir-para-setor': 'transferir-setor',
    'transferir_agente': 'transferir-agente-ia',
    'transferir-agente': 'transferir-agente-ia',
    'transferir-agente-ia': 'transferir-agente-ia',
    'transferir_agente_ia': 'transferir-agente-ia',
    'adicionar_etiqueta': 'adicionar-etiqueta',
    'remover_etiqueta': 'remover-etiqueta',
    'campo_personalizado': 'campo-personalizado',
    'enviar_midia': 'enviar-midia',
    'enviar-media': 'enviar-midia',
    'ferramenta_http': 'ferramenta-http',
    'requisicao-http': 'ferramenta-http',
    'requisicao_http': 'ferramenta-http',
    'requisicao-dinamica': 'ferramenta-http',
    'requisicao_dinamica': 'ferramenta-http',
    http: 'ferramenta-http',
  };

  return aliases[t] || t;
}

export { normalizeTipo };

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
  const dados = acao.dados ?? {};
  const arquivoId = String(dados.arquivoId || '').trim();

  let url = String(dados.url || '').trim() || null;
  let mediaType = String(dados.tipoArquivo || dados.tipo || '').trim().toLowerCase() || null;

  if (!url) {
    const arquivoInfo = ctx.arquivoMap?.get(arquivoId);
    url = arquivoInfo?.url || null;
    mediaType = mediaType || arquivoInfo?.mediaType || null;
  }

  if (!url) {
    logger.warn('enviar-midia: arquivo não encontrado', { arquivoId, temUrlDados: Boolean(dados.url) });
    return { success: false, error: 'Arquivo não encontrado nas instruções' };
  }

  const type = normalizeMediaType(mediaType, url);
  const urlNorm = normalizeMediaUrl(url);
  if (urlNorm && ctx.midiasEnviadas instanceof Set && ctx.midiasEnviadas.has(urlNorm)) {
    logger.info('enviar-midia: URL já enviada nesta resposta — pulando', {
      arquivoId: arquivoId || null,
      url: urlNorm,
      conversaId: ctx.job?.conversaId,
    });
    return { success: true, skipped: true, reason: 'media-already-sent', arquivoId: arquivoId || null, url, tipoArquivo: type };
  }

  // Sem nome/caption — só marcador de tipo para classificar o envio
  const markdown = `[(${type})](${url})`;
  const kind = classifyChunk(markdown);

  const sent = await sendAgentChunk(ctx.job, { kind, text: markdown }, ctx.agentConfig);
  if (sent?.skipped) {
    return {
      success: true,
      skipped: true,
      reason: sent.reason || 'media-already-sent',
      arquivoId: arquivoId || null,
      url,
      tipoArquivo: type,
    };
  }
  if (urlNorm && ctx.midiasEnviadas instanceof Set) ctx.midiasEnviadas.add(urlNorm);
  return { success: true, arquivoId: arquivoId || null, url, tipoArquivo: type };
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
  await cancelarFollowup(ctx.job.conversaId, 'humano_assumiu').catch(() => {});
  return { success: true, atendenteId, statusAtendimento: 'aberto', pausado: true };
}

async function executarNotificarHumano(acao, ctx) {
  try {
    const resultado = await executeNotificarHumano({
      job: ctx.job,
      agente: ctx.agente,
      args: acao.dados ?? {},
      redisUrl: ctx.agentConfig?.redisUrl,
    });
    return resultado;
  } catch (error) {
    logger.warn('notificar-humano falhou — ignorado', { message: error.message });
    return { success: true, ignorado: true, error: error.message };
  }
}

/** Aceita setorId em dados, na raiz da ação, ou (fallback) único transferir-setor das instruções. */
function resolveSetorId(acao, instrucoes) {
  const candidatos = [
    acao?.dados?.setorId,
    acao?.dados?.setor_id,
    acao?.dados?.id,
    acao?.dados?.setor?.id,
    acao?.setorId,
    acao?.setor_id,
    acao?.id,
  ];
  for (const c of candidatos) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const nasInstrucoes = extractActionsFromText(instrucoes)
    .filter((a) => normalizeTipo(a?.tipo) === 'transferir-setor')
    .map((a) => Number(a?.dados?.setorId ?? a?.dados?.setor_id ?? a?.dados?.id ?? a?.setorId))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Um único setor nas instruções: usa ele (modelo às vezes emite o tipo sem copiar o ID).
  if (nasInstrucoes.length === 1) return nasInstrucoes[0];
  return null;
}

async function executarTransferirSetor(acao, ctx) {
  const setorId = resolveSetorId(acao, ctx.agente?.instrucoes);
  if (!setorId) {
    logger.warn('transferir-setor: setorId ausente', {
      conversaId: ctx.job?.conversaId,
      dados: acao?.dados ?? null,
      acaoKeys: acao ? Object.keys(acao) : [],
    });
    return { success: false, error: 'setorId ausente' };
  }

  const dados = { ...(acao.dados ?? {}), setorId };
  const atendenteId = await resolveAtendenteId(dados, {
    contaId: ctx.job.contaId,
    setorId,
  });

  const vincularAtendente = Boolean(atendenteId);
  await transferirConversaSetor({
    conversaId: ctx.job.conversaId,
    setorId,
    atendenteId,
    pausado: vincularAtendente ? true : undefined,
    statusAtendimento: vincularAtendente ? 'aberto' : undefined,
  });
  if (vincularAtendente) {
    await cancelarFollowup(ctx.job.conversaId, 'humano_assumiu').catch(() => {});
  }

  return {
    success: true,
    setorId,
    atendenteId,
    ...(vincularAtendente ? { statusAtendimento: 'aberto', pausado: true } : {}),
  };
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
  return { success: true, modo: 'mover', cardId: card.id, etapaId };
}

async function aplicarPreenchimentoCrm(acao, ctx, cardId) {
  const dados = acao.dados ?? {};
  const querObs = dados.observacoes === true;
  const querValor = dados.valor === true;
  const querTarefa = dados.tarefa === true;

  if (!querObs && !querValor && !querTarefa) {
    return { preenchimento: null, tokensExtras: 0 };
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
    cardId,
    observacoes: querObs ? preenchimento.observacoes : null,
    valor: querValor ? preenchimento.valor : null,
    criarTarefa: querTarefa,
    textoTarefa: preenchimento.tarefaTexto,
    prazoTarefa: preenchimento.tarefaPrazo,
  });

  return {
    preenchimento,
    tokensExtras: preenchimento.totalTokens ?? 0,
  };
}

async function executarCrmPreencher(acao, ctx) {
  const dados = acao.dados ?? {};
  const quadroId = Number(dados.quadroId) || null;

  if (dados.observacoes !== true && dados.valor !== true && dados.tarefa !== true) {
    return { success: false, error: 'Informe ao menos observacoes, valor ou tarefa como true' };
  }

  let card = null;
  if (quadroId && ctx.job.contatoId) {
    card = await buscarCardContato({ contatoId: ctx.job.contatoId, quadroId });
  } else if (ctx.job.contatoId) {
    card = await buscarCardContato({ contatoId: ctx.job.contatoId });
  }

  if (!card?.id) {
    return { success: false, error: 'Card CRM não encontrado' };
  }

  const { preenchimento, tokensExtras } = await aplicarPreenchimentoCrm(acao, ctx, card.id);

  return {
    success: true,
    modo: 'preencher',
    cardId: card.id,
    preenchimento,
    tokensExtras,
  };
}

async function executarCrmCriar(acao, ctx) {
  const dados = acao.dados ?? {};
  const quadroId = Number(dados.quadroId);
  const etapaId = Number(dados.etapaId);

  if (!quadroId || !etapaId || !ctx.job.contatoId) {
    return { success: false, error: 'quadroId, etapaId ou contatoId ausente' };
  }

  const { cardId, criado } = await criarCardCrm({
    quadroId,
    etapaId,
    contatoId: ctx.job.contatoId,
    telefone: ctx.job.telefone,
  });

  const { preenchimento, tokensExtras } = await aplicarPreenchimentoCrm(acao, ctx, cardId);

  return {
    success: true,
    modo: 'criar',
    cardId,
    criado,
    preenchimento,
    tokensExtras,
  };
}

/** Ação unificada do painel: tipo "crm" + dados.modo = criar | mover | preencher */
async function executarCrm(acao, ctx) {
  const modo = String(acao.dados?.modo || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (modo === 'criar' || modo === 'create' || modo === 'novo') {
    return executarCrmCriar(acao, ctx);
  }
  if (modo === 'mover' || modo === 'move' || modo === 'movimentacao') {
    return executarCrmMover(acao, ctx);
  }
  if (modo === 'preencher' || modo === 'fill' || modo === 'atualizar') {
    return executarCrmPreencher(acao, ctx);
  }

  // Fallback: chips antigos sem modo explícito
  const temPreenchimento =
    acao.dados?.observacoes === true || acao.dados?.valor === true || acao.dados?.tarefa === true;
  if (temPreenchimento && !acao.dados?.etapaId) {
    return executarCrmPreencher(acao, ctx);
  }
  if (acao.dados?.etapaId && temPreenchimento) {
    return executarCrmCriar(acao, ctx);
  }
  if (acao.dados?.etapaId) {
    return executarCrmMover(acao, ctx);
  }

  return { success: false, error: `Modo CRM desconhecido: ${acao.dados?.modo || '(vazio)'}` };
}

async function executarFerramentaHttp(acao, ctx) {
  const dados = acao.dados ?? {};
  const httpIndex = Number(dados.httpIndex ?? 0);
  const itens = ctx.agente?.requisicaoHTTP?.itens ?? [];
  const item = itens[Number.isFinite(httpIndex) ? httpIndex : 0];

  if (!item && !dados.url) {
    return { success: false, error: `Ferramenta HTTP índice ${httpIndex} não encontrada` };
  }

  const resolved = applyHttpTemplates(resolveHttpRequestConfig(item || {}, dados), {
    job: ctx.job,
  });
  return dynamicHttpRequest(resolved);
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
  'crm-criar': executarCrmCriar,
  'ferramenta-http': executarFerramentaHttp,
};

const ONCE_PER_CONVERSA = new Set([
  'notificar-humano',
  'transferir-atendente',
  'transferir-setor',
  'transferir-agente-ia',
]);

/** Textos do agente onde um [[acao:...]] explícito pode autorizar execução. */
function collectTextosComAcoes(agente) {
  const textos = [agente?.instrucoes, agente?.abrirAtendimento?.instrucoes];
  for (const item of agente?.notificarHumano?.itens ?? []) {
    textos.push(item?.instrucoes);
  }
  for (const item of agente?.requisicaoHTTP?.itens ?? []) {
    textos.push(item?.instrucao ?? item?.instrucoes);
  }
  return textos.filter((t) => String(t || '').trim()).join('\n');
}

/**
 * Só autoriza ação se existir marcador [[acao:...]] do mesmo tipo nas instruções.
 * Texto livre ("transfira para o setor X") NÃO autoriza — evita o modelo inventar a ação.
 */
export function isActionAuthorizedByInstrucoes(acao, agente) {
  const tipo = normalizeTipo(acao?.tipo);
  if (!tipo) return false;

  // HTTP do painel costuma vir só com texto livre + curl (sem [[acao:]]).
  // Se a ferramenta estiver ativa, autoriza o tipo ferramenta-http.
  if (tipo === 'ferramenta-http' && agente?.requisicaoHTTP?.ativo === true) {
    return true;
  }

  const autorizadas = extractActionsFromText(collectTextosComAcoes(agente));
  return autorizadas.some((a) => normalizeTipo(a?.tipo) === tipo);
}

export async function executeAgentAction(acao, ctx) {
  const tipo = normalizeTipo(acao?.tipo);
  const executor = EXECUTORES[tipo];

  if (!executor) {
    logger.warn('Ação desconhecida', { tipo: acao?.tipo });
    return { success: false, error: `Ação desconhecida: ${acao?.tipo}` };
  }

  if (!isActionAuthorizedByInstrucoes(acao, ctx.agente)) {
    logger.warn('Ação bloqueada — não há [[acao:]] correspondente nas instruções', {
      tipo,
      conversaId: ctx.job?.conversaId,
      dados: acao?.dados ?? null,
    });
    return { success: false, error: 'acao nao autorizada nas instrucoes', blocked: true };
  }

  // Lock no executor (notificar já tem o seu). Transferências: Redis NX.
  if (ONCE_PER_CONVERSA.has(tipo) && tipo !== 'notificar-humano') {
    const acquired = await tryAcquireActionLock(
      ctx.agentConfig?.redisUrl || process.env.REDIS_URL?.trim() || null,
      ctx.job?.conversaId,
      tipo,
      5,
    );
    if (!acquired) {
      logger.info('Ação ignorada (lock recente)', { tipo, conversaId: ctx.job?.conversaId });
      return { success: true, skipped: true, reason: 'duplicate-lock' };
    }
  }

  try {
    const resultado = await executor(acao, ctx);
    if (resultado?.skipped) {
      logger.info('Ação pulada', { tipo, conversaId: ctx.job?.conversaId, reason: resultado.reason });
    } else {
      logger.info('Ação executada', { tipo, conversaId: ctx.job?.conversaId, resultado });
    }
    return resultado;
  } catch (error) {
    logger.warn('Falha ao executar ação — ignorado, agente continua', {
      tipo,
      conversaId: ctx.job?.conversaId,
      message: error.message,
    });
    return { success: false, error: error.message };
  }
}
