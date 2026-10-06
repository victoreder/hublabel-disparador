import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { isValidEmailAddress, sendDispatchEmail } from '../../email/smtp.js';
import { logger } from '../../logger.js';
import { fetchConfigEmails } from '../../supabase.js';
import { enviarTemplate, verificarDonoTemplate } from '../acoes/enviarTemplate.js';
import { criarInstrucao, gerarMensagensIa, testarOpenAi } from '../acoes/ia.js';
import { sincronizarEmailResetSupabase, sincronizarSmtpSupabase } from '../acoes/supabaseAuthConfig.js';
import {
  adicionarMembro,
  cadastrarUsuarioGratis,
  criarUsuarioAdmin,
  excluirAuthUser,
} from '../acoes/usuarios.js';
import { processarIntegracaoPagamento, processarWebhookLead } from '../acoes/webhookEntrada.js';
import { protegida } from '../auth/autenticar.js';
import { envInt, ipDoCliente, limitarTaxa } from '../auth/rateLimit.js';
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
  app.post('/uploadmedia', allowCors, protegida('/uploadmedia'), upload.any(), (req, res) =>
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
  // Público por natureza (o id secreto na URL é a credencial); o limite segura abuso/força bruta.
  const limite = limitarTaxa({
    nome: path,
    max: envInt('WEBHOOK_ENTRADA_LIMITE_MINUTO', 120),
    janelaMs: 60_000,
  });

  app.options(path, allowCors);
  app.post(path, allowCors, limite, ...parsers, (req, res) => {
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

function opcoes(path, extra = {}) {
  return { ...extra, middlewares: [protegida(path), ...(extra.middlewares ?? [])] };
}

export function registerAcoesRoutes(app, { inboundConfig }) {
  registerUpload(app, inboundConfig);

  // Cadastro grátis: público, com limite por IP e chave para desligar na stack.
  const cadastroGratisAtivo = process.env.CADASTRO_GRATIS_ATIVO?.trim().toLowerCase() !== 'false';
  postJson(
    app,
    '/usuario-gratis',
    (req) => {
      if (!cadastroGratisAtivo) throw new HttpError('Cadastro gratuito desativado.', 403);
      return cadastrarUsuarioGratis(req.body);
    },
    {
      middlewares: [
        limitarTaxa({
          nome: 'usuario-gratis',
          max: envInt('CADASTRO_GRATIS_LIMITE_HORA', 5),
          janelaMs: 60 * 60_000,
          chave: ipDoCliente,
        }),
      ],
    },
  );

  // Super admin
  postJson(app, '/criar-usuario', (req) => criarUsuarioAdmin(req.body), opcoes('/criar-usuario'));
  postJson(
    app,
    '/excluir-conta',
    async (req) => {
      await excluirAuthUser(req.body?.auth_user_id);
      logger.info('[excluir-conta] auth user removido', {
        authUserId: req.body?.auth_user_id,
        por: req.usuario?.authUserId ?? 'api-key',
      });
      return { ok: true };
    },
    opcoes('/excluir-conta'),
  );

  // Admin da conta: o membro sempre entra na conta de quem está logado
  // (super admin / api key podem informar outra conta no body).
  postJson(
    app,
    '/adicionar-usuario',
    (req) => {
      const contaId = req.usuario.superAdmin ? req.body?.contaId ?? req.usuario.contaId : req.usuario.contaId;
      if (!contaId) throw new HttpError('contaId é obrigatório', 400);
      return adicionarMembro({ ...req.body, contaId });
    },
    opcoes('/adicionar-usuario', { authErrorAsString: true }),
  );

  // IA (usuário logado com conta ativa)
  app.options('/testar-openai', allowCors);
  app.post('/testar-openai', allowCors, protegida('/testar-openai'), (req, res) =>
    responder(res, async () => {
      const result = await testarOpenAi();
      res.status(result.status).json(result.json);
    }),
  );
  postJson(app, '/criar-instrucao', (req) => criarInstrucao(req.body), opcoes('/criar-instrucao'));
  postJson(app, '/gerarmensagem-ia', (req) => gerarMensagensIa(req.body), opcoes('/gerarmensagem-ia'));

  // E-mail / Supabase Auth (super admin)
  for (const [path, fn] of [
    ['/sincronizar-supabase', sincronizarSmtpSupabase],
    ['/email-supabase', sincronizarEmailResetSupabase],
  ]) {
    app.options(path, allowCors);
    app.post(path, allowCors, protegida(path), (req, res) =>
      responder(res, async () => {
        const result = await fn(req.body ?? {});
        res.status(result.status).json(result.json);
      }),
    );
  }

  // Teste de SMTP: um único destinatário. Com credenciais no body testa o
  // remetente informado (tela de Configurações); sem credenciais usa o SMTP
  // do sistema (SAAS_Config_Emails), o que só o super admin pode fazer.
  postJson(
    app,
    '/enviar-teste-email',
    async (req) => {
      const body = req.body ?? {};
      if (!isValidEmailAddress(body.para)) throw new HttpError('Informe um único e-mail válido em "para".', 400);

      let remetente = body;
      if (!body.smtp_host) {
        if (!req.usuario.superAdmin) throw new HttpError('Informe as credenciais SMTP do remetente.', 400);
        remetente = await fetchConfigEmails();
      }
      const info = await sendDispatchEmail({
        remetente: { id: 'teste', ...remetente },
        to: body.para,
        subject: body.assunto,
        html: body.html,
      });
      return { ok: true, messageId: info.messageId };
    },
    opcoes('/enviar-teste-email', {
      middlewares: [
        limitarTaxa({
          nome: 'enviar-teste-email',
          max: envInt('TESTE_EMAIL_LIMITE_HORA', 20),
          janelaMs: 60 * 60_000,
          chave: (req) => req.usuario?.authUserId ?? ipDoCliente(req),
        }),
      ],
    }),
  );

  // O SMTP agora é lido direto de SAAS_Config_Emails; a tela ainda chama esta rota ao salvar.
  postJson(app, '/alterar-credencial-smtp', () => ({ ok: true }), opcoes('/alterar-credencial-smtp'));

  // API Oficial: só envia por conexão e para contato da própria conta.
  postJson(
    app,
    '/enviar-template',
    async (req) => {
      if (!req.usuario.superAdmin) await verificarDonoTemplate(req.body ?? {}, req.usuario.contaId);
      return enviarTemplate(req.body, { graphVersion: inboundConfig.metaGraphApiVersion });
    },
    opcoes('/enviar-template'),
  );

  // Base de conhecimento (mesmo handler de /agente-no-whatsapp/inserir-conhecimento)
  app.post('/inserir-conhecimento', protegida('/inserir-conhecimento'), handleRagIngestRequest);

  // Webhooks de entrada (leads e pagamento)
  registerWebhookEntrada(app, '/token', ({ token, payload }) =>
    processarWebhookLead({ token, payload, evolutionBaseUrl: inboundConfig.evolutionBaseUrl }),
  );
  registerWebhookEntrada(app, '/integracao', processarIntegracaoPagamento);

  logger.info('[acoes] rotas registradas');
}
