import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { sendDispatchEmail } from '../../email/smtp.js';
import { logger } from '../../logger.js';
import { fetchConfigEmails } from '../../supabase.js';
import { enviarTemplate } from '../acoes/enviarTemplate.js';
import { criarInstrucao, gerarMensagensIa, testarOpenAi } from '../acoes/ia.js';
import { sincronizarEmailResetSupabase, sincronizarSmtpSupabase } from '../acoes/supabaseAuthConfig.js';
import {
  adicionarMembro,
  cadastrarUsuarioGratis,
  criarUsuarioAdmin,
  excluirAuthUser,
} from '../acoes/usuarios.js';
import { processarIntegracaoPagamento, processarWebhookLead } from '../acoes/webhookEntrada.js';
import { HttpError } from '../meta/httpError.js';
import { buildPublicS3Url, createS3Client, sanitizeS3FileName, uploadBuffer } from '../storage/s3.js';
import { allowCors, postJson, responder } from './responder.js';
import { handleRagIngestRequest } from './rag.js';

/**
 * Ações que o front chamava nos webhooks do n8n — mesmas URLs e mesmos
 * formatos de resposta (BACK_URL/<slug>).
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number.parseInt(process.env.UPLOAD_MAX_FILE_BYTES ?? '', 10) || 100 * 1024 * 1024,
  },
});

function nomeOriginal(req, file) {
  const doForm = String(req.body?.originalFileName ?? '').trim();
  if (doForm) return doForm;
  // busboy entrega o filename em latin1; converte para manter acentos.
  return Buffer.from(file.originalname || '', 'latin1').toString('utf8');
}

function registerUpload(app, inboundConfig) {
  const s3 = createS3Client(inboundConfig.s3);

  app.options('/uploadmedia', allowCors);
  app.post('/uploadmedia', allowCors, upload.any(), (req, res) =>
    responder(
      res,
      async () => {
        const file = req.files?.[0];
        if (!file) throw new HttpError('Nenhum arquivo enviado (campo "file")', 400);

        const fileName = sanitizeS3FileName(nomeOriginal(req, file));
        // Prefixo único: dois uploads com o mesmo nome não se sobrescrevem
        // (o chat já remove esse prefixo ao exibir o nome do arquivo).
        const key = `${randomUUID()}-${fileName}`;
        await uploadBuffer({
          client: s3,
          bucket: inboundConfig.s3.bucket,
          key,
          body: file.buffer,
          contentType: file.mimetype,
        });

        const link = buildPublicS3Url(inboundConfig.s3.publicBaseUrl, key);
        return { link, url: link, fileName, mimeType: file.mimetype, fileSize: file.size };
      },
      { tag: 'uploadmedia' },
    ),
  );
}

/** Webhook de entrada: responde na hora (como o n8n) e processa em segundo plano. */
function registerWebhookEntrada(app, path, processar) {
  const parsers = [express.urlencoded({ extended: true, limit: '5mb' }), express.text({ limit: '5mb' })];

  app.options(path, allowCors);
  app.post(path, allowCors, ...parsers, (req, res) => {
    const token = String(req.query?.id ?? '').trim();
    const payload = req.body ?? {};
    res.status(200).json({ message: 'Workflow was started' });

    const startedAt = Date.now();
    processar({ token, payload })
      .then((result) => logger.info(`[${path}] processado`, { token, durationMs: Date.now() - startedAt, ...result }))
      .catch((error) =>
        logger.error(`[${path}] erro`, { token, message: error.message, stack: error.stack }),
      );
  });
}

export function registerAcoesRoutes(app, { inboundConfig }) {
  registerUpload(app, inboundConfig);

  // Usuários / contas
  postJson(app, '/usuario-gratis', (req) => cadastrarUsuarioGratis(req.body));
  postJson(app, '/criar-usuario', (req) => criarUsuarioAdmin(req.body));
  postJson(app, '/adicionar-usuario', (req) => adicionarMembro(req.body), { authErrorAsString: true });
  postJson(app, '/excluir-conta', async (req) => {
    await excluirAuthUser(req.body?.auth_user_id);
    return { ok: true };
  });

  // IA
  app.options('/testar-openai', allowCors);
  app.post('/testar-openai', allowCors, (req, res) =>
    responder(res, async () => {
      const result = await testarOpenAi();
      res.status(result.status).json(result.json);
    }),
  );
  postJson(app, '/criar-instrucao', (req) => criarInstrucao(req.body));
  postJson(app, '/gerarmensagem-ia', (req) => gerarMensagensIa(req.body));

  // E-mail / Supabase Auth
  for (const [path, fn] of [
    ['/sincronizar-supabase', sincronizarSmtpSupabase],
    ['/email-supabase', sincronizarEmailResetSupabase],
  ]) {
    app.options(path, allowCors);
    app.post(path, allowCors, (req, res) =>
      responder(res, async () => {
        const result = await fn(req.body ?? {});
        res.status(result.status).json(result.json);
      }),
    );
  }

  postJson(app, '/enviar-teste-email', async (req) => {
    const body = req.body ?? {};
    const remetente = body.smtp_host ? body : await fetchConfigEmails();
    const info = await sendDispatchEmail({
      remetente: { id: 'teste', ...remetente },
      to: body.para,
      subject: body.assunto,
      html: body.html,
    });
    return { ok: true, messageId: info.messageId };
  });

  // O SMTP agora é lido direto de SAAS_Config_Emails; a tela ainda chama esta rota ao salvar.
  postJson(app, '/alterar-credencial-smtp', () => ({ ok: true }));

  // API Oficial
  postJson(app, '/enviar-template', (req) =>
    enviarTemplate(req.body, { graphVersion: inboundConfig.metaGraphApiVersion }),
  );

  // Base de conhecimento (mesmo handler de /agente-no-whatsapp/inserir-conhecimento)
  app.post('/inserir-conhecimento', handleRagIngestRequest);

  // Webhooks de entrada (leads e pagamento)
  registerWebhookEntrada(app, '/token', ({ token, payload }) =>
    processarWebhookLead({ token, payload, evolutionBaseUrl: inboundConfig.evolutionBaseUrl }),
  );
  registerWebhookEntrada(app, '/integracao', processarIntegracaoPagamento);

  logger.info('[acoes] rotas registradas');
}
