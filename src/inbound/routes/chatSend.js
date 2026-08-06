import { logger } from '../../logger.js';
import { enviarMensagemChat, enviarMidiaChat } from '../chat/send.js';
import { HttpError } from '../meta/httpError.js';

function normalizeAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function parseMultipartData(body = {}) {
  if (typeof body.data !== 'string') return body;

  try {
    const parsed = JSON.parse(body.data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...body, ...parsed };
    }
  } catch {
    // "data" também pode ser apenas o nome do campo binário; mantém o body original.
  }

  return body;
}

function isEvolutionWebhookShape(body = {}) {
  return Boolean(body.event || body.instance || (body.data && typeof body.data === 'object'));
}

function actionFromRequest(req) {
  const body = parseMultipartData(req.body ?? {});
  const explicit = normalizeAction(
    body.acao ??
      body.action ??
      req.query?.acao ??
      req.query?.action,
  );
  if (explicit) return explicit;

  // Nunca inferir envio do chat a partir de payload Evolution (event/instance/data).
  if (isEvolutionWebhookShape(body)) return '';

  // Compatibilidade com o payload atual do chat: basta trocar a URL do n8n
  // pela rota compartilhada, sem adicionar um campo novo no frontend.
  if (body.idMensagem && body.type) return 'enviarmidia';
  if (body.idMensagem && body.mensagem != null) return 'enviarmensagem';
  return '';
}

export function isChatSendRequest(req) {
  const body = parseMultipartData(req.body ?? {});
  const action = actionFromRequest(req);
  const isSendAction =
    action === 'enviarmensagem' ||
    action === 'enviarmidia' ||
    action === 'enviaraudio';

  // Mesmo com acao explícita, webhook Evolution não entra no fluxo de envio do chat.
  if (!isSendAction || isEvolutionWebhookShape(body)) return false;
  return true;
}

function pickUploadedFile(req) {
  if (req.file) return req.file;
  if (Array.isArray(req.files)) return req.files[0] ?? null;

  return (
    req.files?.arquivo?.[0] ??
    req.files?.midia?.[0] ??
    req.files?.file?.[0] ??
    req.files?.data?.[0] ??
    req.files?.documento?.[0] ??
    null
  );
}

function safeBody(body = {}) {
  return {
    acao: body.acao ?? body.action ?? null,
    idConexao: body.idConexao ?? null,
    idMensagem: body.idMensagem ?? null,
    idMensagem2: body.idMensagem2 ?? null,
    type: body.type ?? null,
    hasMensagem: Boolean(body.mensagem),
    hasCaption: Boolean(body.caption),
  };
}

export async function handleChatSendRequest(req, res) {
  const startedAt = Date.now();
  const body = parseMultipartData(req.body ?? {});
  const action = actionFromRequest(req);
  const isMedia = action === 'enviarmidia' || action === 'enviaraudio';

  logger.info('[chat-envio] hit', {
    method: req.method,
    path: req.path,
    body: safeBody(body),
    hasFile: Boolean(pickUploadedFile(req)),
  });

  try {
    const result = isMedia
      ? await enviarMidiaChat(body, pickUploadedFile(req), req.app.locals.inboundConfig)
      : await enviarMensagemChat(body, req.app.locals.inboundConfig);

    logger.info('[chat-envio] ok', {
      durationMs: Date.now() - startedAt,
      acao: result.acao,
      provedor: result.provedor,
      messageId: result.messageId,
      enderecamento: result.enderecamento,
    });
    return res.status(200).json(result);
  } catch (error) {
    const status = error instanceof HttpError ? error.statusCode : 500;
    const log = {
      durationMs: Date.now() - startedAt,
      status,
      body: safeBody(body),
      message: error instanceof Error ? error.message : String(error),
    };

    if (status >= 500) logger.error('[chat-envio] erro', log);
    else logger.warn('[chat-envio] rejeitado', log);

    return res.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
}
