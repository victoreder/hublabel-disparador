const ACTION_PREFIX = '[[acao:';
const ACTION_SUFFIX = ']]';

function extractActionJson(raw, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonStart = -1;

  for (let i = startIndex; i < raw.length; i += 1) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) jsonStart = i;
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && jsonStart >= 0) {
        return {
          jsonText: raw.slice(jsonStart, i + 1),
          endIndex: i + 1,
        };
      }
    }
  }

  return null;
}

function skipWs(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

export function parseAgentOutputWithActions(output) {
  const text = String(output || '');
  if (!text.trim()) return [];

  const segments = [];
  let cursor = 0;

  while (cursor < text.length) {
    const actionStart = text.indexOf(ACTION_PREFIX, cursor);
    if (actionStart === -1) {
      const tail = text.slice(cursor).trim();
      if (tail) segments.push({ type: 'text', content: tail });
      break;
    }

    if (actionStart > cursor) {
      const chunk = text.slice(cursor, actionStart).trim();
      if (chunk) segments.push({ type: 'text', content: chunk });
    }

    const jsonStart = actionStart + ACTION_PREFIX.length;
    const extracted = extractActionJson(text, jsonStart);

    if (!extracted) {
      // Marcador incompleto — descarta do [[acao: até o fim (nunca vaza ao usuário)
      break;
    }

    const suffixStart = skipWs(text, extracted.endIndex);
    if (text.slice(suffixStart, suffixStart + ACTION_SUFFIX.length) !== ACTION_SUFFIX) {
      // JSON ok mas sem ]] — tenta parsear mesmo assim (modelos às vezes esquecem o sufixo)
      try {
        const parsed = JSON.parse(extracted.jsonText);
        if (parsed?.tipo) {
          segments.push({ type: 'action', content: parsed });
        }
      } catch {
        // ignore
      }
      cursor = extracted.endIndex;
      continue;
    }

    try {
      const parsed = JSON.parse(extracted.jsonText);
      if (parsed?.tipo) {
        segments.push({ type: 'action', content: parsed });
      }
    } catch {
      // JSON inválido — descarta o marcador silenciosamente
    }

    cursor = suffixStart + ACTION_SUFFIX.length;
  }

  return segments;
}

/** Extrai só as ações [[acao:...]] de um texto (ex.: instruções do agente). */
export function extractActionsFromText(text) {
  return parseAgentOutputWithActions(text)
    .filter((segment) => segment.type === 'action')
    .map((segment) => segment.content);
}

/** Remove qualquer resíduo de [[acao:...]] que ainda possa ter sobrado no texto. */
export function stripActionMarkers(text) {
  return String(text || '')
    .replace(/\[\[acao:[\s\S]*?\]\]/g, '')
    .replace(/\[\[acao:[\s\S]*$/g, '')
    .trim();
}

export function stripActionsFromText(text) {
  const segments = parseAgentOutputWithActions(text);
  return stripActionMarkers(
    segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => segment.content)
      .join('\n\n'),
  );
}

const MEDIA_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/;

export function buildArquivoMapFromInstrucoes(instrucoes) {
  const map = new Map();
  const source = String(instrucoes || '');

  const actionRe = /\[\[acao:\{[\s\S]*?"arquivoId"\s*:\s*"([^"]+)"[\s\S]*?\}\]\]/g;
  let actionMatch;

  while ((actionMatch = actionRe.exec(source)) !== null) {
    const arquivoId = actionMatch[1];
    const after = source.slice(actionMatch.index + actionMatch[0].length);
    const linkMatch = after.match(MEDIA_LINK_RE);
    if (!linkMatch) continue;

    const label = linkMatch[1];
    const url = linkMatch[2];
    const typeMatch = label.match(/\(([^)]+)\)\s*$/i);
    const mediaType = typeMatch?.[1]?.toLowerCase() || 'file';

    map.set(arquivoId, { url, label, mediaType });
  }

  return map;
}

export function resolveMediaMarkdown(arquivoInfo) {
  if (!arquivoInfo?.url) return null;

  const type = String(arquivoInfo.mediaType || 'file').toLowerCase();
  // Sem nome do arquivo — caption nunca deve ser o label
  return `[(${type})](${arquivoInfo.url})`;
}
