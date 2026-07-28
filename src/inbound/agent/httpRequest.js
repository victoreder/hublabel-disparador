const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Extrai url/method/headers/body de um curl salvo pelo painel. */
export function parseCurl(curl) {
  const text = String(curl || '').trim();
  if (!text) return null;

  const methodMatch = text.match(/curl\s+-X\s+(\w+)/i);
  const urlMatch =
    text.match(/curl\s+-X\s+\w+\s+"([^"]+)"/i) ||
    text.match(/curl\s+-X\s+\w+\s+'([^']+)'/i) ||
    text.match(/curl\s+"([^"]+)"/i) ||
    text.match(/curl\s+'([^']+)'/i);

  const dataMatch =
    text.match(/-d\s+'([^']*)'/) ||
    text.match(/-d\s+"([^"]*)"/) ||
    text.match(/--data(?:-raw)?\s+'([^']*)'/) ||
    text.match(/--data(?:-raw)?\s+"([^"]*)"/);

  const headers = {};
  const headerRe = /-H\s+"([^"]+)"|-H\s+'([^']+)'/g;
  let hm;
  while ((hm = headerRe.exec(text))) {
    const raw = hm[1] || hm[2] || '';
    const colon = raw.indexOf(':');
    if (colon > 0) {
      headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
  }

  let body = null;
  if (dataMatch?.[1] != null && dataMatch[1] !== '') {
    const raw = dataMatch[1];
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  return {
    url: urlMatch?.[1] || null,
    method: (methodMatch?.[1] || 'GET').toUpperCase(),
    headers,
    body,
  };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isEmptyObject(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * Resolve a requisição a partir do item configurado + args da tool/ação.
 * Aceita formato do painel (curl/quandoAtivar) e formato novo (url/metodo/body).
 */
export function resolveHttpRequestConfig(item = {}, args = {}) {
  const fromCurl = item?.curl ? parseCurl(item.curl) : null;

  const url = String(args.url || item?.url || fromCurl?.url || '').trim();
  const method = String(
    args.method || item?.method || item?.metodo || fromCurl?.method || 'GET',
  )
    .trim()
    .toUpperCase();

  let headers = args.headers ?? item?.headers ?? fromCurl?.headers ?? {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) headers = {};

  let body =
    args.body !== undefined
      ? args.body
      : item?.body !== undefined
        ? item.body
        : item?.corpo !== undefined
          ? item.corpo
          : fromCurl?.body;

  body = parseMaybeJson(body);
  if (isEmptyObject(body)) body = null;

  const queryParams =
    args.queryParams ?? item?.queryParams ?? item?.params ?? fromCurl?.queryParams ?? {};

  return {
    url,
    method,
    headers,
    body,
    queryParams:
      queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
        ? queryParams
        : {},
  };
}

/** Substitui {{telefone}}, {{conversaId}}, etc. em url/body/headers. */
export function applyHttpTemplates(config, ctx = {}) {
  const telefone = String(ctx.job?.telefone || ctx.telefone || '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/\D/g, '');

  const vars = {
    telefone,
    numero: telefone,
    phone: telefone,
    conversaId: String(ctx.job?.conversaId ?? ''),
    contatoId: String(ctx.job?.contatoId ?? ''),
    contaId: String(ctx.job?.contaId ?? ''),
    ...(ctx.vars && typeof ctx.vars === 'object' ? ctx.vars : {}),
  };

  const replaceInString = (text) =>
    String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, key) => {
      const k = String(key || '').trim();
      if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null && vars[k] !== '') {
        return String(vars[k]);
      }
      // case-insensitive fallback
      const found = Object.keys(vars).find((vk) => vk.toLowerCase() === k.toLowerCase());
      if (found && vars[found] != null && vars[found] !== '') return String(vars[found]);
      return full;
    });

  const replaceDeep = (value) => {
    if (value == null) return value;
    if (typeof value === 'string') return replaceInString(value);
    if (Array.isArray(value)) return value.map(replaceDeep);
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = replaceDeep(v);
      return out;
    }
    return value;
  };

  return {
    ...config,
    url: config.url ? replaceInString(config.url) : config.url,
    headers: replaceDeep(config.headers || {}),
    body: replaceDeep(config.body),
    queryParams: replaceDeep(config.queryParams || {}),
  };
}

export async function dynamicHttpRequest({ url, method, headers, body, queryParams }) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (!url?.trim()) {
    return { success: false, error: "Campo 'url' é obrigatório." };
  }
  if (!VALID_METHODS.has(upperMethod)) {
    return { success: false, error: `Método '${upperMethod}' inválido.` };
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return { success: false, error: `URL inválida: ${url}` };
  }

  if (queryParams && typeof queryParams === 'object') {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value != null) targetUrl.searchParams.set(key, String(value));
    }
  }

  const init = {
    method: upperMethod,
    headers: headers && Object.keys(headers).length ? { ...headers } : undefined,
  };

  if (!['GET', 'DELETE'].includes(upperMethod) && body != null && body !== '') {
    if (typeof body === 'string') {
      init.headers = { 'Content-Type': 'text/plain; charset=utf-8', ...headers };
      init.body = body;
    } else {
      init.headers = { 'Content-Type': 'application/json', ...headers };
      init.body = JSON.stringify(body);
    }
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
