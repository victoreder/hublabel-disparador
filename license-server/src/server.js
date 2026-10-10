import { createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

const port = Number.parseInt(process.env.PORT || '3100', 10);
const adminToken = required('ADMIN_TOKEN');
// Tolerância que o cliente ganha a cada validação para continuar rodando se este servidor cair.
const graceHours = Number.parseInt(process.env.GRACE_HOURS || '72', 10);
const privateKey = createPrivateKey(Buffer.from(required('LICENSE_PRIVATE_KEY'), 'base64').toString('utf8'));
// Supabase EXCLUSIVO do vendedor (só a tabela de licenças). Nunca o Supabase de um cliente.
const db = createClient(required('LICENCAS_SUPABASE_URL'), required('LICENCAS_SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

function log(level, message, meta) {
  const line = `[${level}] ${new Date().toISOString()} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
}

function signed(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  return { payload: data.toString('base64'), assinatura: sign(null, data, privateKey).toString('base64') };
}

function clientIp(req) {
  return String(req.ip || req.socket.remoteAddress || '');
}

// Limite simples por IP contra tentativa de adivinhar e-mails de licença.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > 60_000) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > 30;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, entry] of hits) if (entry.start < cutoff) hits.delete(ip);
}, 60_000).unref();

async function registrarEvento(licencaId, tipo, info, detalhe) {
  const { error } = await db.from('licenca_eventos').insert({
    licenca_id: licencaId,
    tipo,
    ip: info.ip,
    hostname: info.hostname,
    servico: info.servico,
    instalacao: info.instalacao,
    detalhe: detalhe ?? null,
  });
  if (error) log('ERROR', 'Falha ao registrar evento', { message: error.message });
}

async function validar(body, ip) {
  const email = String(body.email || '').trim().toLowerCase();
  const fingerprint = String(body.fingerprint || '');
  const info = {
    ip,
    hostname: String(body.hostname || '').slice(0, 200),
    servico: String(body.servico || '').slice(0, 50),
    instalacao: String(body.instalacao || '').slice(0, 200),
  };

  const recusa = (motivo) => ({ ok: false, motivo });

  if (!email || !/^[a-f0-9]{64}$/.test(fingerprint)) return { resultado: recusa('dados de licença incompletos') };

  const { data: licenca, error } = await db.from('licencas').select('*').eq('email', email).maybeSingle();
  if (error) throw error;
  if (!licenca) return { resultado: recusa('e-mail sem licença cadastrada') };
  if (licenca.status !== 'ativa') {
    await registrarEvento(licenca.id, 'recusada', info, `status ${licenca.status}`);
    return { resultado: recusa(`licença ${licenca.status}`) };
  }
  if (licenca.expira_em && Date.parse(licenca.expira_em) < Date.now()) {
    await registrarEvento(licenca.id, 'recusada', info, 'expirada');
    return { resultado: recusa('licença expirada') };
  }

  const agora = new Date().toISOString();

  if (!licenca.fingerprint) {
    // Primeira ativação. O filtro "fingerprint is null" evita que duas instalações ativem ao mesmo tempo.
    const { data: ativada, error: errAtivar } = await db
      .from('licencas')
      .update({ fingerprint, instalacao: info.instalacao, ativada_em: agora })
      .eq('id', licenca.id)
      .is('fingerprint', null)
      .select('fingerprint')
      .maybeSingle();
    if (errAtivar) throw errAtivar;
    if (!ativada) return validar(body, ip);
    licenca.fingerprint = fingerprint;
    await registrarEvento(licenca.id, 'ativacao', info);
    log('INFO', 'Licença ativada', { email, instalacao: info.instalacao });
  }

  if (licenca.fingerprint !== fingerprint) {
    await registrarEvento(licenca.id, 'recusada', info, 'outra instalação');
    return {
      resultado: recusa('licença já ativada em outra instalação — fale com o suporte para transferir'),
    };
  }

  if (licenca.ultimo_ip && licenca.ultimo_ip !== ip) {
    await registrarEvento(licenca.id, 'validacao', info, `ip mudou de ${licenca.ultimo_ip}`);
  }

  await db
    .from('licencas')
    .update({ ultimo_check_em: agora, ultimo_ip: ip, ultimo_hostname: info.hostname, versao: body.versao ?? null })
    .eq('id', licenca.id);

  const validoAte = new Date(
    Math.min(
      Date.now() + graceHours * 3600_000,
      licenca.expira_em ? Date.parse(licenca.expira_em) : Number.POSITIVE_INFINITY,
    ),
  ).toISOString();

  return { resultado: { ok: true, cliente: licenca.cliente || licenca.email, validoAte } };
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // só o Traefik na frente
app.use(express.json({ limit: '16kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'hublabel-licenca' }));

app.post('/v1/validar', async (req, res) => {
  const ip = clientIp(req);
  const fingerprint = String(req.body?.fingerprint || '');
  const nonce = String(req.body?.nonce || '').slice(0, 64);
  const responder = (resultado) =>
    res.json(signed({ ...resultado, fingerprint, nonce, emitidoEm: new Date().toISOString() }));

  // Respostas sem assinatura (429/503) o cliente trata como indisponibilidade, não como recusa.
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'muitas tentativas' });

  try {
    const { resultado } = await validar(req.body || {}, ip);
    if (!resultado.ok) log('WARN', 'Licença recusada', { ip, motivo: resultado.motivo, instalacao: req.body?.instalacao });
    responder(resultado);
  } catch (error) {
    log('ERROR', 'Erro ao validar licença', { message: error.message });
    res.status(503).json({ ok: false, error: 'indisponivel' });
  }
});

// ---------- Administração (Authorization: Bearer ADMIN_TOKEN) ----------

function requireAdmin(req, res, next) {
  const token = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(adminToken);
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
    return res.status(401).json({ ok: false, error: 'nao autorizado' });
  }
  next();
}

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/licencas', async (_req, res) => {
  const { data, error } = await db.from('licencas').select('*').order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, licencas: data });
});

admin.post('/licencas', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email.includes('@')) return res.status(400).json({ ok: false, error: 'email obrigatorio' });
  const { data, error } = await db
    .from('licencas')
    .insert({
      email,
      cliente: req.body?.cliente ?? null,
      expira_em: req.body?.expira_em ?? null,
      observacao: req.body?.observacao ?? null,
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  log('INFO', 'Licença criada', { email });
  res.status(201).json({ ok: true, licenca: data });
});

// Libera a licença para ser ativada em outra instalação (troca de VPS/Supabase do cliente).
admin.post('/licencas/:email/resetar', async (req, res) => {
  const { data, error } = await db
    .from('licencas')
    .update({ fingerprint: null, instalacao: null, ativada_em: null })
    .eq('email', req.params.email.trim().toLowerCase())
    .select('id, email')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'licenca nao encontrada' });
  await registrarEvento(data.id, 'reset', { ip: clientIp(req) });
  res.json({ ok: true, licenca: data });
});

admin.post('/licencas/:email/status', async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['ativa', 'suspensa', 'revogada'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'status deve ser ativa, suspensa ou revogada' });
  }
  const { data, error } = await db
    .from('licencas')
    .update({ status })
    .eq('email', req.params.email.trim().toLowerCase())
    .select('id, email, status')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'licenca nao encontrada' });
  await registrarEvento(data.id, 'status', { ip: clientIp(req) }, status);
  res.json({ ok: true, licenca: data });
});

app.use('/admin', admin);

app.listen(port, () => log('INFO', 'Servidor de licenças ouvindo', { port }));
