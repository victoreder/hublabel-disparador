-- Rode no SEU Supabase (o do vendedor), não no dos clientes.

create table if not exists public.licencas (
  id               bigint generated always as identity primary key,
  chave            text not null unique,
  email            text not null,
  cliente          text,
  status           text not null default 'ativa' check (status in ('ativa', 'suspensa', 'revogada')),
  -- Instalação à qual a licença está presa (hash do host do Supabase do cliente). Null = ainda não ativada.
  fingerprint      text,
  instalacao       text,
  ativada_em       timestamptz,
  expira_em        timestamptz,          -- null = vitalícia
  ultimo_check_em  timestamptz,
  ultimo_ip        text,
  ultimo_hostname  text,
  versao           text,
  observacao       text,
  criado_em        timestamptz not null default now()
);

create table if not exists public.licenca_eventos (
  id          bigint generated always as identity primary key,
  licenca_id  bigint references public.licencas(id) on delete cascade,
  tipo        text not null,   -- ativacao | validacao | recusada | reset | status
  ip          text,
  hostname    text,
  servico     text,
  instalacao  text,
  detalhe     text,
  criado_em   timestamptz not null default now()
);

create index if not exists licenca_eventos_licenca_idx on public.licenca_eventos (licenca_id, criado_em desc);

-- Só o service_role (servidor de licenças) acessa.
alter table public.licencas enable row level security;
alter table public.licenca_eventos enable row level security;
