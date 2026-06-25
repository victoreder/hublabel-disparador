-- Schema Meta WhatsApp API Oficial (HubLabel / whitelabel)
-- Aplicado via migration create_meta_whatsapp_tables

create table if not exists public.meta_whatsapp_conexoes (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid references public.contas(id) on delete cascade,
  nome text,
  business_id text,
  waba_id text not null,
  phone_number_id text not null,
  access_token text not null,
  expires_in integer,
  expires_at timestamptz,
  status text not null default 'ativa' check (status in ('ativa', 'expirada', 'revogada')),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone_number_id)
);

create table if not exists public.meta_whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references public.meta_whatsapp_conexoes(id) on delete cascade,
  waba_id text not null,
  name text not null,
  language text not null default 'pt_BR',
  category text,
  status text,
  meta_template_id text,
  components jsonb not null default '[]'::jsonb,
  meta_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conexao_id, name, language)
);

create table if not exists public.meta_whatsapp_mensagens_enviadas (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid references public.meta_whatsapp_conexoes(id) on delete set null,
  phone_number_id text,
  destinatario text not null,
  tipo text not null,
  meta_message_id text,
  payload jsonb,
  meta_response jsonb,
  status text not null default 'enviada',
  created_at timestamptz not null default now()
);
