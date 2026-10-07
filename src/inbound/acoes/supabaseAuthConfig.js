import { config } from '../../config.js';
import { HttpError } from '../meta/httpError.js';

/**
 * Sincroniza SMTP / template de "esqueci a senha" no Auth do Supabase via
 * Management API (PATCH /v1/projects/{ref}/config/auth), usando o token
 * pessoal (PAT) que o admin informa na aba E-mails.
 */

function projectRef(body) {
  const fromBody = String(body.project_ref ?? '').trim();
  if (/^[a-z0-9]{10,40}$/.test(fromBody)) return fromBody;
  const match = config.supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (match) return match[1];
  throw new HttpError('Não foi possível identificar o project_ref do Supabase', 400);
}

function semVazios(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

async function patchAuthConfig(body, payload) {
  const pat = String(body.supabase_pat ?? '').trim();
  if (!pat) throw new HttpError('supabase_pat é obrigatório', 400);

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef(body)}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(semVazios(payload)),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  return { status: res.status, json };
}

/** POST /sincronizar-supabase */
export function sincronizarSmtpSupabase(body = {}) {
  const p = body.payload ?? {};
  return patchAuthConfig(body, {
    external_email_enabled: p.external_email_enabled,
    smtp_admin_email: p.smtp_admin_email,
    smtp_sender_name: p.smtp_sender_name,
    smtp_host: p.smtp_host,
    smtp_port: p.smtp_port != null ? String(p.smtp_port) : undefined,
    smtp_user: p.smtp_user,
    smtp_pass: p.smtp_pass,
    site_url: p.site_url,
  });
}

/** POST /email-supabase — [variavel] vira {{variavel}} (sintaxe do Supabase). */
export function sincronizarEmailResetSupabase(body = {}) {
  const p = body.payload ?? {};
  const conteudo =
    p.mailer_templates_recovery_content != null
      ? String(p.mailer_templates_recovery_content).replace(/\[([^\]]+)\]/g, '{{$1}}')
      : undefined;

  return patchAuthConfig(body, {
    mailer_subjects_recovery: p.mailer_subjects_recovery,
    mailer_templates_recovery_content: conteudo,
    external_email_enabled: p.external_email_enabled,
    smtp_admin_email: body.smtp_email,
    smtp_sender_name: body.smtp_name,
    smtp_host: body.smtp_host,
    smtp_port: body.smtp_port != null ? String(body.smtp_port) : undefined,
    smtp_user: body.smtp_user,
    smtp_pass: body.smtp_apikey,
  });
}
