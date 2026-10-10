-- USO INTERNO DO VENDEDOR — NÃO faz parte da instalação do cliente.
-- Rode SOMENTE no Supabase separado de licenças (o mesmo de LICENCAS_SUPABASE_URL do servidor de licenças).
-- Não rode no Supabase de clientes nem envie este arquivo a eles.

create table if not exists public.licencas (
  id               bigint generated always as identity primary key,
  -- E-mail da compra: é a licença. O cliente informa só ele (LICENCA_EMAIL) na stack.
  email            text not null unique,
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

-- Guarda o e-mail sempre em minúsculo/sem espaços (cadastro manual ou automático pelo checkout).
create or replace function public.licencas_normaliza_email() returns trigger language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;

drop trigger if exists licencas_normaliza_email on public.licencas;
create trigger licencas_normaliza_email before insert or update of email on public.licencas
  for each row execute function public.licencas_normaliza_email();

create index if not exists licenca_eventos_licenca_idx on public.licenca_eventos (licenca_id, criado_em desc);

-- Só o service_role (servidor de licenças) acessa.
alter table public.licencas enable row level security;
alter table public.licenca_eventos enable row level security;
