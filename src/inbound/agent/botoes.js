import { extractActionsFromText } from './parseActions.js';

const FRASES_CLIQUE_RE =
  /\b(clique|clica|toque|toque\s+na|escolha\s+(uma\s+)?(das\s+)?op[cç][oõ]e?s?\s+abaixo|selecione\s+(uma\s+)?(das\s+)?op[cç][oõ]e?s?\s+abaixo|veja\s+as\s+op[cç][oõ]e?s?\s+abaixo)[^.!?\n]*[.!?]?\s*/gi;

/** Remove frases que anunciam botões — o menu já vai na mesma mensagem. */
export function corpoMenuBotoes(texto) {
  return String(texto || '')
    .replace(FRASES_CLIQUE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function asOpcao(item, index) {
  if (item == null) return null;
  if (typeof item === 'string') {
    const label = item.trim();
    if (!label) return null;
    return { id: String(index + 1), label };
  }
  if (typeof item === 'object') {
    const label = String(item.label || item.texto || item.title || item.nome || '').trim();
    if (!label) return null;
    const id = String(item.id ?? item.value ?? index + 1).trim() || String(index + 1);
    return { id, label };
  }
  return null;
}

export function normalizeOpcoes(dados = {}) {
  const raw = dados.opcoes ?? dados.opções ?? dados.choices ?? dados.botoes ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map(asOpcao).filter(Boolean);
}

/**
 * Monta payload interno do menu a partir da config do marcador / chip.
 * estilo: "botoes" | "lista" (aliases: button/buttons, list)
 */
export function buildMenuPayload(dados = {}) {
  const estiloRaw = String(dados.estilo || dados.formato || dados.tipo || 'botoes')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const isLista = estiloRaw === 'lista' || estiloRaw === 'list';
  const opcoes = normalizeOpcoes(dados);
  const max = isLista ? 10 : 3;
  const maxLabel = isLista ? 24 : 20;
  const sliced = opcoes.slice(0, max);
  if (!sliced.length) return null;

  const choices = sliced.map((o, i) => {
    const label = String(o.label).slice(0, maxLabel);
    const id = String(o.id || i + 1).slice(0, isLista ? 200 : 256);
    return `${label}|${id}`;
  });

  const footerText = String(dados.footerText || dados.footer || '').trim().slice(0, 60);
  const listButton = String(dados.listButton || dados.botaoLista || 'Ver opções')
    .trim()
    .slice(0, 20);

  return {
    tipo: isLista ? 'list' : 'button',
    choices,
    ...(footerText ? { footerText } : {}),
    ...(isLista ? { listButton: listButton || 'Ver opções' } : {}),
  };
}

/** Evolution: pergunta + opções em texto (sem botão nativo). */
export function formatMenuAsTexto(corpo, menu) {
  const pergunta = String(corpo || '').trim() || 'Escolha uma opção:';
  const lines = (menu?.choices || []).map((c) => {
    const [title] = String(c).split('|');
    return `— ${String(title || '').trim()}`.trim();
  }).filter((l) => l.length > 1);
  if (!lines.length) return pergunta;
  return `${pergunta}\n${lines.join('\n')}`;
}

export function labelsDoMenu(menu) {
  return (menu?.choices || [])
    .map((c) => String(c).split('|')[0].trim())
    .filter(Boolean);
}

function isTipoEnviarBotoes(tipo) {
  const t = String(tipo || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, '-');
  return t === 'enviar-botoes' || t === 'enviarbotoes' || t === 'enviar-botao' || t === 'enviarbotao';
}

export function agenteTemEnviarBotoes(agente) {
  const textos = [
    agente?.instrucoes,
    agente?.abrirAtendimento?.instrucoes,
    ...(agente?.notificarHumano?.itens ?? []).map((i) => i?.instrucoes),
    ...(agente?.requisicaoHTTP?.itens ?? []).map((i) => i?.instrucao ?? i?.instrucoes),
  ]
    .filter((t) => String(t || '').trim())
    .join('\n');

  return extractActionsFromText(textos).some((a) => isTipoEnviarBotoes(a?.tipo));
}

/**
 * Junta texto imediatamente antes de [[acao:enviar-botoes]] no corpo do menu
 * (não envia esse texto sozinho).
 */
export function attachPendingBotoes(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const out = [];
  let pendingTexts = [];

  const flushTexts = () => {
    if (!pendingTexts.length) return;
    out.push({ type: 'text', content: pendingTexts.join('\n\n') });
    pendingTexts = [];
  };

  for (const seg of list) {
    if (seg?.type === 'text') {
      const t = String(seg.content || '').trim();
      if (t) pendingTexts.push(t);
      continue;
    }

    if (seg?.type === 'action' && isTipoEnviarBotoes(seg.content?.tipo)) {
      const corpo = pendingTexts.join('\n\n').trim();
      pendingTexts = [];
      out.push({
        type: 'action',
        content: {
          ...seg.content,
          dados: {
            ...(seg.content?.dados || {}),
            ...(corpo ? { _corpoMenu: corpo } : {}),
          },
        },
      });
      continue;
    }

    flushTexts();
    out.push(seg);
  }

  flushTexts();
  return out;
}
