import { logger } from '../../../logger.js';
import { resolveProvedorApi } from '../../../provedorApi.js';
import {
  abrirAtendimentoHumano,
  fetchAgente,
  fetchConexaoById,
  fetchContato,
  supabase,
} from '../../../supabase.js';
import { getAgentConfig } from '../config.js';
import { loadChatHistory } from '../memory.js';
import { buildSystemPrompt } from '../prompt.js';
import { saveAgentTokenUsage } from '../tokens.js';
import { detectarPrazoFollowup, lerFollowupDinamico } from './dinamico.js';
import {
  dispararFakeCallFollowup,
  enviarMenuFollowup,
  enviarMidiaFollowup,
  enviarTextoFollowup,
} from './send.js';

function atrasoDoPasso(passo) {
  const n = Number(passo?.atrasoMinutos ?? passo?.atrasoMin);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function tipoMidiaPorArquivo(item) {
  const mime = String(item?.mime || item?.mimetype || '').toLowerCase();
  const nome = `${item?.url || ''} ${item?.nome || item?.nomeArquivo || ''}`.toLowerCase();
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/i.test(nome)) return 'imagem';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(nome)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|ogg|opus|wav|m4a|aac)$/i.test(nome)) return 'audio';
  return 'documento';
}

function normalizarItem(item) {
  if (!item || !item.tipo) return null;
  const tipo = String(item.tipo).toLowerCase();
  if (tipo === 'midia' || tipo === 'media') {
    return {
      ...item,
      tipo: tipoMidiaPorArquivo(item),
      url: String(item.url || '').trim(),
      nomeArquivo: item.nome || item.nomeArquivo || null,
    };
  }
  return item;
}

function orientacaoDoPasso(passo) {
  return String(passo?.instrucaoIa || passo?.mensagem || '').trim();
}

function normalizarPasso(passo) {
  if (!passo) return null;
  const atrasoMin = atrasoDoPasso(passo);
  if (!atrasoMin) return null;
  const itens = Array.isArray(passo.itens)
    ? passo.itens.map(normalizarItem).filter(Boolean)
    : [];
  return {
    ...passo,
    atrasoMin,
    modo: passo.modo === 'ia' ? 'ia' : 'fixa',
    mensagem: orientacaoDoPasso(passo),
    itens,
    acaoFinal: passo.acaoFinal || 'nenhuma',
  };
}

export function readFollowup(agente) {
  const raw = agente?.followup;
  if (!raw || typeof raw !== 'object' || raw.ativo !== true) return null;
  const passos = (Array.isArray(raw.passos) ? raw.passos : [])
    .map(normalizarPasso)
    .filter(Boolean);
  if (!passos.length) return null;
  return {
    ativo: true,
    pararSeHumano: raw.pararSeHumano !== false,
    respeitarHorario: raw.respeitarHorario !== false,
    passos,
    dinamico: raw.dinamico,
  };
}

function aplicarVariaveis(texto, ctx) {
  let out = String(texto || '');
  const mapa = {
    nome: ctx.nome || '',
    telefone: ctx.telefone || '',
    email: ctx.email || '',
    empresa: ctx.empresa || '',
  };
  for (const [k, v] of Object.entries(mapa)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'gi'), v);
  }
  return out;
}

function dentroHorarioComercial(date) {
  const hora = Number(
    new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      hour12: false,
      timeZone: 'America/Sao_Paulo',
    }).format(date),
  );
  return hora >= 8 && hora < 20;
}

export async function cancelarFollowup(idConversa, motivo) {
  if (!idConversa) return;
  await supabase
    .from('FollowupExecucao')
    .update({
      status: 'parado',
      motivoParada: motivo,
      atualizadoEm: new Date().toISOString(),
    })
    .eq('idConversa', idConversa)
    .eq('status', 'agendado');
}

async function pararFollowup(id, motivo) {
  await supabase
    .from('FollowupExecucao')
    .update({
      status: 'parado',
      motivoParada: motivo,
      atualizadoEm: new Date().toISOString(),
    })
    .eq('id', id);
}

async function adiarFollowup(id, minutos) {
  await supabase
    .from('FollowupExecucao')
    .update({
      proximoEm: new Date(Date.now() + minutos * 60_000).toISOString(),
      atualizadoEm: new Date().toISOString(),
    })
    .eq('id', id);
}

async function conversaTemConversao(idConversa) {
  if (!idConversa) return false;
  const { data } = await supabase
    .from('SAAS_Conversas_Agentes')
    .select('statusAtendimento')
    .eq('id', idConversa)
    .maybeSingle();
  if (String(data?.statusAtendimento || '').toLowerCase() === 'fechado') return true;
  try {
    const { count } = await supabase
      .from('Conversoes')
      .select('id', { count: 'exact', head: true })
      .eq('idConversa', idConversa);
    return (count || 0) > 0;
  } catch {
    return false;
  }
}

async function ultimaMensagemEntradaEm(idConversa) {
  const { data } = await supabase
    .from('SAAS_Mensagens')
    .select('created_at')
    .eq('conversaId', idConversa)
    .eq('fromMe', false)
    .eq('apagada', false)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = data?.created_at;
  return raw ? new Date(raw) : null;
}

async function ultimaMensagemEhEntrada(idConversa) {
  const { data } = await supabase
    .from('SAAS_Mensagens')
    .select('fromMe')
    .eq('conversaId', idConversa)
    .eq('apagada', false)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? data.fromMe === false : false;
}

function buildEnvio(conexao, canal) {
  if (!conexao) return {};
  const provedor = resolveProvedorApi(conexao);
  return {
    apiOficial: Boolean(conexao.apiOficial) || provedor === 'oficial' || canal === 'meta',
    provedorApi: provedor === 'oficial' ? 'evolution' : provedor,
    serverUrl: conexao.urlApi || null,
    instance: conexao.instanceName || null,
    apikey: conexao.Apikey || null,
    accessToken: conexao.access_token ?? null,
    phoneNumberId: conexao.phone_number_id ?? null,
  };
}

async function jobDeFollowup(row, agente) {
  const conexao = row.idConexao ? await fetchConexaoById(row.idConexao) : null;
  const canal = row.canal || (conexao?.apiOficial ? 'meta' : resolveProvedorApi(conexao));
  return {
    canal,
    contaId: row.idConta,
    conexaoId: row.idConexao,
    conversaId: row.idConversa,
    contatoId: row.idContato,
    telefone: row.telefone,
    agenteId: row.idAgente,
    agente: agente || undefined,
    conexao,
    envio: buildEnvio(conexao, canal),
    textoEntrada: null,
  };
}

async function contextoVariaveis(job) {
  const telefone = String(job.telefone || '').replace(/\D/g, '');
  let nome = '';
  let email = '';
  let empresa = '';
  if (job.contatoId) {
    try {
      const c = await fetchContato(job.contatoId);
      nome = String(c?.nome || '').trim();
      email = String(c?.email || '').trim();
      const vars = c?.variaveis && typeof c.variaveis === 'object' ? c.variaveis : {};
      empresa = String(vars.empresa || vars.Empresa || '').trim();
    } catch {
      /* ignore */
    }
  }
  job.nomeContato = nome || null;
  return { nome, telefone, email, empresa };
}

function itensDoPasso(passo) {
  if (Array.isArray(passo.itens) && passo.itens.length) {
    return passo.itens.filter((it) => it && it.tipo);
  }
  const orientacao = orientacaoDoPasso(passo);
  if (orientacao) return [{ tipo: 'texto', texto: orientacao }];
  return [];
}

async function completarTextoIa({ job, agente, agentConfig, orientacao, motivo, vars }) {
  if (!agentConfig?.openaiApiKey) return '';
  const modelo = String(agente.modelo || agentConfig.pendingAnalysisModel || 'gpt-4o-mini');
  const historico = await loadChatHistory(
    job.conversaId,
    Number(agente.qntMsgHistorico) || 20,
    agentConfig.redisUrl,
    agentConfig.historyCacheTtlSec,
  );
  const systemPrompt = buildSystemPrompt(job, agente);
  const extra = aplicarVariaveis(orientacao, vars);
  const instrucao =
    motivo === 'dinamico'
      ? [
          'O cliente pediu para ser contactado neste momento.',
          'Escreva UMA única mensagem curta e natural retomando o assunto combinado,',
          'no mesmo tom do agente, sem parecer robótico e sem repetir a última mensagem.',
          extra ? `Instruções extras: ${extra}` : '',
          'Responda somente com o texto da mensagem.',
        ]
          .filter(Boolean)
          .join('\n')
      : [
          'O cliente parou de responder nesta conversa.',
          'Escreva UMA única mensagem curta e natural para retomar o contato,',
          'no mesmo tom do agente, sem parecer robótico e sem repetir a última mensagem.',
          extra ? `Orientação para esta tentativa: ${extra}` : '',
          'Responda somente com o texto da mensagem.',
        ]
          .filter(Boolean)
          .join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentConfig.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelo,
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        ...historico.slice(-12),
        { role: 'user', content: instrucao },
      ],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
  const tot = Number(json.usage?.total_tokens ?? 0);
  if (tot > 0) await saveAgentTokenUsage(job.agenteId, tot, modelo);
  return String(json.choices?.[0]?.message?.content || '').trim();
}

async function resolverTextoItem(row, agente, passo, item, agentConfig, job, vars, { opcional } = {}) {
  if (passo.modo === 'ia') {
    if (opcional && !String(item.texto || '').trim()) return '';
    return completarTextoIa({
      job,
      agente,
      agentConfig,
      orientacao: String(item.texto || orientacaoDoPasso(passo)).trim(),
      motivo: 'silencio',
      vars,
    });
  }
  return aplicarVariaveis(item.texto || '', vars);
}

async function marcarUltimoMenu(rowId, menu) {
  if (!rowId || !menu) return;
  await supabase
    .from('FollowupExecucao')
    .update({ ultimoMenu: { origem: 'followup', ...menu }, atualizadoEm: new Date().toISOString() })
    .eq('id', rowId);
}

async function enviarItem(row, agente, passo, item, agentConfig, job, vars) {
  const tipo = item.tipo;
  if (tipo === 'fake_call') {
    await dispararFakeCallFollowup(job, item.segundos);
    return;
  }
  if (
    tipo === 'midia' ||
    tipo === 'media' ||
    tipo === 'imagem' ||
    tipo === 'video' ||
    tipo === 'audio' ||
    tipo === 'documento'
  ) {
    const url = String(item.url || '').trim();
    if (!url) return;
    const kind = tipo === 'midia' || tipo === 'media' ? tipoMidiaPorArquivo(item) : tipo;
    const caption = await resolverTextoItem(row, agente, passo, item, agentConfig, job, vars, {
      opcional: true,
    });
    await enviarMidiaFollowup(job, kind, url, caption, agentConfig);
    return;
  }
  if (tipo === 'botoes' || tipo === 'lista') {
    const texto = await resolverTextoItem(row, agente, passo, item, agentConfig, job, vars);
    const labels = (item.opcoes || []).map((o) => String(o || '').trim()).filter(Boolean);
    if (tipo === 'botoes') {
      const choices = labels.slice(0, 3).map((l, i) => `${l.slice(0, 20)}|${i + 1}`);
      if (!choices.length) {
        if (texto.trim()) await enviarTextoFollowup(job, texto, agentConfig);
        return;
      }
      const menu = {
        tipo: 'button',
        choices,
        ...(item.footer?.trim() ? { footerText: item.footer.trim() } : {}),
      };
      await enviarMenuFollowup(job, texto.trim() || 'Escolha uma opção:', menu, agentConfig);
      await marcarUltimoMenu(row.id, menu);
      return;
    }
    const choices = labels.slice(0, 10).map((l, i) => `${l.slice(0, 24)}|${i + 1}`);
    if (!choices.length) {
      if (texto.trim()) await enviarTextoFollowup(job, texto, agentConfig);
      return;
    }
    const menu = {
      tipo: 'list',
      choices,
      listButton: (item.listButton || 'Ver opções').slice(0, 20),
      ...(item.footer?.trim() ? { footerText: item.footer.trim() } : {}),
    };
    await enviarMenuFollowup(job, texto.trim() || 'Escolha uma opção:', menu, agentConfig);
    await marcarUltimoMenu(row.id, menu);
    return;
  }
  if (tipo === 'catalogo') {
    const extra = await resolverTextoItem(row, agente, passo, item, agentConfig, job, vars, {
      opcional: true,
    });
    const produtoId = String(item.produtoId || '').trim();
    if (produtoId) {
      const { data: prod } = await supabase
        .from('SAAS_Produtos')
        .select('nome, descricao, imagemUrl, preco')
        .eq('id', produtoId)
        .maybeSingle();
      if (prod) {
        const corpo = [prod.nome, prod.preco != null ? `R$ ${prod.preco}` : '', prod.descricao, extra]
          .filter(Boolean)
          .join('\n');
        if (prod.imagemUrl) await enviarMidiaFollowup(job, 'imagem', prod.imagemUrl, corpo, agentConfig);
        else if (corpo) await enviarTextoFollowup(job, corpo, agentConfig);
        return;
      }
    }
    if (extra?.trim()) await enviarTextoFollowup(job, extra, agentConfig);
    return;
  }
  const texto = await resolverTextoItem(row, agente, passo, item, agentConfig, job, vars);
  if (texto.trim()) await enviarTextoFollowup(job, texto, agentConfig);
}

async function enviarPasso(row, agente, passo, agentConfig) {
  const job = await jobDeFollowup(row, agente);
  const vars = await contextoVariaveis(job);
  const itens = itensDoPasso(passo);
  if (!itens.length) {
    const texto =
      passo.modo === 'ia'
        ? await completarTextoIa({
            job,
            agente,
            agentConfig,
            orientacao: orientacaoDoPasso(passo),
            motivo: 'silencio',
            vars,
          })
        : aplicarVariaveis(passo.mensagem || '', vars);
    if (texto?.trim()) await enviarTextoFollowup(job, texto, agentConfig);
    return;
  }
  for (const item of itens) {
    try {
      await enviarItem(row, agente, passo, item, agentConfig, job, vars);
    } catch (err) {
      logger.warn('Follow-up: falha ao enviar item', {
        tipo: item.tipo,
        conversaId: row.idConversa,
        message: err.message,
      });
    }
  }
}

export async function agendarFollowupDinamico(job, agente, agentConfig) {
  const din = lerFollowupDinamico(agente?.followup);
  if (!din) return;
  if (await conversaTemConversao(job.conversaId)) return;

  const historico = await loadChatHistory(
    job.conversaId,
    Number(agente.qntMsgHistorico) || 20,
    agentConfig?.redisUrl,
    agentConfig?.historyCacheTtlSec,
  );
  const det = await detectarPrazoFollowup({
    agentConfig,
    mensagemCliente: job.textoEntrada || '',
    historico,
    tetoDias: din.tetoDias,
  });
  if (!det) return;
  if (det.creditos > 0) {
    await saveAgentTokenUsage(job.agenteId, det.promptTokens + det.completionTokens, det.modelo);
  }
  if (!det.quando) return;

  const agora = new Date().toISOString();
  await supabase.from('FollowupExecucao').upsert(
    {
      idConta: job.contaId,
      idConversa: job.conversaId,
      idAgente: job.agenteId,
      idContato: job.contatoId || null,
      idConexao: job.conexaoId || null,
      canal: job.canal || null,
      telefone: job.telefone || null,
      tipo: 'dinamico',
      passoAtual: 0,
      proximoEm: det.quando.toISOString(),
      status: 'agendado',
      motivoParada: null,
      atualizadoEm: agora,
    },
    { onConflict: 'idConversa,tipo' },
  );

  if (din.desligarCadencia) {
    await supabase
      .from('FollowupExecucao')
      .update({ status: 'parado', motivoParada: 'dinamico', atualizadoEm: agora })
      .eq('idConversa', job.conversaId)
      .eq('tipo', 'cadencia')
      .eq('status', 'agendado');
  }
}

export async function agendarFollowup(job, agente) {
  const fu = readFollowup(agente);
  if (!fu) return;
  if (await conversaTemConversao(job.conversaId)) return;

  const din = lerFollowupDinamico(agente.followup);
  if (din?.desligarCadencia) {
    const { data: dinRow } = await supabase
      .from('FollowupExecucao')
      .select('id')
      .eq('idConversa', job.conversaId)
      .eq('tipo', 'dinamico')
      .eq('status', 'agendado')
      .maybeSingle();
    if (dinRow) return;
  }

  const { data: existente } = await supabase
    .from('FollowupExecucao')
    .select('passoAtual, status')
    .eq('idConversa', job.conversaId)
    .eq('tipo', 'cadencia')
    .maybeSingle();

  if (existente?.status === 'concluido') return;

  const passoAtual = Number(existente?.passoAtual || 0);
  const passo = fu.passos[passoAtual];
  if (!passo) return;

  const agora = new Date().toISOString();
  await supabase.from('FollowupExecucao').upsert(
    {
      idConta: job.contaId,
      idConversa: job.conversaId,
      idAgente: job.agenteId,
      idContato: job.contatoId || null,
      idConexao: job.conexaoId || null,
      canal: job.canal || null,
      telefone: job.telefone || null,
      tipo: 'cadencia',
      passoAtual,
      proximoEm: new Date(Date.now() + Number(passo.atrasoMin) * 60_000).toISOString(),
      status: 'agendado',
      motivoParada: null,
      atualizadoEm: agora,
    },
    { onConflict: 'idConversa,tipo' },
  );
}

export async function agendarFollowupsAposTurno(job, agente, agentConfig) {
  if (!job?.conversaId || !agente) return;
  await agendarFollowupDinamico(job, agente, agentConfig).catch((err) =>
    logger.warn('Agendar follow-up dinâmico', { message: err.message, conversaId: job.conversaId }),
  );
  await agendarFollowup(job, agente).catch((err) =>
    logger.warn('Agendar follow-up cadência', { message: err.message, conversaId: job.conversaId }),
  );
}

async function revalidarComum(row, agente, pararSeHumano, respeitarHorario) {
  const id = row.id;
  const idConversa = row.idConversa;
  const { data: conversa } = await supabase
    .from('SAAS_Conversas_Agentes')
    .select('pausado, statusAtendimento')
    .eq('id', idConversa)
    .maybeSingle();

  if (!conversa) {
    await pararFollowup(id, 'agente_indisponivel');
    return { ok: false };
  }
  if (String(conversa.statusAtendimento || '').toLowerCase() === 'fechado') {
    await pararFollowup(id, 'atendimento_finalizado');
    return { ok: false };
  }
  if (await ultimaMensagemEhEntrada(idConversa)) {
    await pararFollowup(id, 'cliente_respondeu');
    return { ok: false };
  }
  if (conversa.pausado && pararSeHumano) {
    await pararFollowup(id, 'humano_assumiu');
    return { ok: false };
  }
  if (await conversaTemConversao(idConversa)) {
    await pararFollowup(id, 'conversao');
    return { ok: false };
  }
  const ultimaEntrada = await ultimaMensagemEntradaEm(idConversa);
  if (ultimaEntrada && Date.now() - ultimaEntrada.getTime() > 24 * 60 * 60_000) {
    await pararFollowup(id, 'janela_24h');
    return { ok: false };
  }
  if (respeitarHorario && !dentroHorarioComercial(new Date())) {
    await adiarFollowup(id, 60);
    return { ok: false };
  }
  return { ok: true, conversa };
}

async function processarCadencia(row, agentConfig) {
  const passoAtual = Number(row.passoAtual || 0);
  const agente = row.idAgente ? await fetchAgente(row.idAgente) : null;
  const fu = agente ? readFollowup(agente) : null;
  if (!agente || !fu || agente.ativo === false) {
    await pararFollowup(row.id, 'agente_indisponivel');
    return;
  }
  const passo = fu.passos[passoAtual];
  if (!passo) {
    await supabase
      .from('FollowupExecucao')
      .update({ status: 'concluido', atualizadoEm: new Date().toISOString() })
      .eq('id', row.id);
    return;
  }

  const check = await revalidarComum(row, agente, fu.pararSeHumano, fu.respeitarHorario);
  if (!check.ok) return;

  await enviarPasso(row, agente, passo, agentConfig);

  const proxIndex = passoAtual + 1;
  const acao = passo.acaoFinal || 'nenhuma';
  const agora = new Date().toISOString();

  if (acao === 'transferir_humano') {
    await abrirAtendimentoHumano({ telefone: row.telefone, conexaoId: row.idConexao });
    await supabase
      .from('FollowupExecucao')
      .update({
        status: 'concluido',
        passoAtual: proxIndex,
        motivoParada: 'transferido_humano',
        atualizadoEm: agora,
      })
      .eq('id', row.id);
    return;
  }

  if (acao === 'encerrar' || proxIndex >= fu.passos.length) {
    if (acao === 'encerrar') {
      await supabase
        .from('SAAS_Conversas_Agentes')
        .update({ statusAtendimento: 'fechado', pausado: true })
        .eq('id', row.idConversa);
    }
    await supabase
      .from('FollowupExecucao')
      .update({ status: 'concluido', passoAtual: proxIndex, atualizadoEm: agora })
      .eq('id', row.id);
    return;
  }

  await supabase
    .from('FollowupExecucao')
    .update({
      passoAtual: proxIndex,
      proximoEm: new Date(Date.now() + Number(fu.passos[proxIndex].atrasoMin) * 60_000).toISOString(),
      status: 'agendado',
      atualizadoEm: agora,
    })
    .eq('id', row.id);
}

async function processarDinamico(row, agentConfig) {
  const agente = row.idAgente ? await fetchAgente(row.idAgente) : null;
  const din = agente ? lerFollowupDinamico(agente.followup) : null;
  if (!agente || !din || agente.ativo === false) {
    await pararFollowup(row.id, 'agente_indisponivel');
    return;
  }
  const rawFu = agente.followup || {};
  const check = await revalidarComum(
    row,
    agente,
    rawFu.pararSeHumano !== false,
    rawFu.respeitarHorario !== false,
  );
  if (!check.ok) return;

  const job = await jobDeFollowup(row, agente);
  const vars = await contextoVariaveis(job);
  const texto = await completarTextoIa({
    job,
    agente,
    agentConfig,
    orientacao: din.instrucoes,
    motivo: 'dinamico',
    vars,
  });
  if (texto?.trim()) await enviarTextoFollowup(job, texto, agentConfig);

  await supabase
    .from('FollowupExecucao')
    .update({ status: 'concluido', atualizadoEm: new Date().toISOString() })
    .eq('id', row.id);
}

export async function processarFollowupsPendentes(limite = 25) {
  const { data: pendentes, error } = await supabase
    .from('FollowupExecucao')
    .select('*')
    .eq('status', 'agendado')
    .lte('proximoEm', new Date().toISOString())
    .order('proximoEm', { ascending: true })
    .limit(limite);

  if (error) {
    logger.warn('Follow-up: falha ao listar pendentes', { message: error.message });
    return 0;
  }

  const agentConfig = await getAgentConfig();
  let processados = 0;
  for (const row of pendentes || []) {
    try {
      if (String(row.tipo || 'cadencia') === 'dinamico') {
        await processarDinamico(row, agentConfig);
      } else {
        await processarCadencia(row, agentConfig);
      }
      processados += 1;
    } catch (err) {
      logger.warn('Follow-up: falha ao processar', { id: row.id, message: err.message });
    }
  }
  return processados;
}

export async function tentarRetomarPorMenuFollowup({ resultado, organized, conexao, canal }) {
  const conversaId = resultado?.conversaId;
  if (!conversaId) return null;
  const temClique = Boolean(
    organized?.idInterativo ||
      organized?.isButtonReply ||
      resultado?.idInterativo ||
      /button|list|interactive/i.test(String(organized?.messageType || resultado?.tipoMensagem || '')),
  );
  if (!temClique) return null;

  const { data: conv } = await supabase
    .from('SAAS_Conversas_Agentes')
    .select('idAgente, pausado')
    .eq('id', conversaId)
    .maybeSingle();
  if (conv?.pausado) return null;

  const { data: fu } = await supabase
    .from('FollowupExecucao')
    .select('idAgente, ultimoMenu')
    .eq('idConversa', conversaId)
    .not('ultimoMenu', 'is', null)
    .order('atualizadoEm', { ascending: false })
    .limit(1)
    .maybeSingle();

  const menu = fu?.ultimoMenu;
  if (!menu || String(menu.origem || '') !== 'followup') return null;
  if (!Array.isArray(menu.choices) || !menu.choices.length) return null;

  const agenteId = resultado.agenteId || conv?.idAgente || fu.idAgente;
  if (!agenteId) return null;
  const agente = await fetchAgente(agenteId);
  if (!agente || agente.ativo === false) return null;

  return {
    resultado: { ...resultado, agente, agenteId: agente.id },
    agente,
    conexao,
    canal,
  };
}
