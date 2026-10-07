-- =============================================================================
-- Migração n8n → código (telas + ações). Rode UMA vez no SQL Editor do Supabase.
-- Idempotente: pode rodar de novo sem quebrar nada.
-- =============================================================================

-- 1) Personalização white-label (linha única id=1).
--    Lida pelo servidor ao montar cada tela; editada pela aba Personalização do admin.
create table if not exists public."SAAS_Personalizacao" (
  id               bigint primary key default 1 check (id = 1),
  nome             text,
  cor              text,          -- hex sem '#', ex.: 25D366
  "telefoneSuporte" text,         -- só dígitos, ex.: 5548984549300
  "logoUrl"        text,          -- vazio = <SUPABASE_URL>/storage/v1/object/public/arquivos/LOGO%20PRINCIPAL.png
  "faviconUrl"     text,          -- vazio = <SUPABASE_URL>/storage/v1/object/public/arquivos/FAVICON.png
  updated_at       timestamptz not null default now()
);

insert into public."SAAS_Personalizacao" (id, nome, cor, "telefoneSuporte")
values (1, 'Disparamator', '25D366', '5548984549300')
on conflict (id) do nothing;

-- Só o backend (service_role) lê/escreve; o navegador não acessa a tabela.
alter table public."SAAS_Personalizacao" enable row level security;

-- 2) Página de vendas (/pv). Criada pelo botão "Criar" no admin a partir do
--    HTML padrão do repositório; as edições ficam salvas aqui.
create table if not exists public."SAAS_PaginaVendas" (
  id         bigint primary key default 1 check (id = 1),
  html       text not null,
  updated_at timestamptz not null default now()
);

alter table public."SAAS_PaginaVendas" enable row level security;

-- 3) Wrappers com parâmetros nomeados para as funções que o n8n chamava por
--    SQL posicional (o backend usa supabase.rpc, que exige nomes).
create or replace function public.f_hub_meta_preparar_envio_template(p_body jsonb)
returns jsonb
language sql
as $$
  select to_jsonb(public.f_meta_preparar_envio_template(p_body));
$$;

create or replace function public.f_hub_webhook_sincronizar_contato(
  p_conta_id  uuid,
  p_telefone  text,
  p_nome      text,
  p_campos    jsonb,
  p_etiquetas bigint[]
)
returns jsonb
language sql
as $$
  select to_jsonb(public.f_webhook_sincronizar_contato(p_conta_id, p_telefone, p_nome, p_campos, p_etiquetas));
$$;

create or replace function public.f_hub_conversa_ou_mensagem(
  p_telefone   text,
  p_id_conexao bigint,
  p_user_id    uuid,
  p_mensagem   text,
  p_message_id text,
  p_id_agente  bigint
)
returns jsonb
language sql
as $$
  select to_jsonb(public.f_conversa_ou_mensagem(p_telefone, p_id_conexao, p_user_id, p_mensagem, p_message_id, p_id_agente));
$$;

-- Wrappers só para o backend (não expõe nada novo para anon/authenticated).
revoke all on function public.f_hub_meta_preparar_envio_template(jsonb) from public, anon, authenticated;
revoke all on function public.f_hub_webhook_sincronizar_contato(uuid, text, text, jsonb, bigint[]) from public, anon, authenticated;
revoke all on function public.f_hub_conversa_ou_mensagem(text, bigint, uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.f_hub_meta_preparar_envio_template(jsonb) to service_role;
grant execute on function public.f_hub_webhook_sincronizar_contato(uuid, text, text, jsonb, bigint[]) to service_role;
grant execute on function public.f_hub_conversa_ou_mensagem(text, bigint, uuid, text, text, bigint) to service_role;

-- Recarrega o cache de schema do PostgREST para as novas funções aparecerem no rpc().
notify pgrst, 'reload schema';
