# HubLabel — Disparador Meta (API Oficial)

Worker Node.js que consome a fila `SAAS_Detalhes_Disparos` e envia mensagens via WhatsApp Cloud API (Graph API v25).

## O que faz

- Processa apenas conexões com `apiOficial = true`
- Envia **templates** (texto, mídia, botões)
- Ignora `dataEnvio` do detalhe — dispara o mais rápido possível
- Respeita apenas `DataAgendamento` do disparo para **início** da campanha (janela de 24h)
- `StatusDisparo`, `TipoDisparo` e status inativos: comparação **case insensitive**
- Para imediatamente se `StatusDisparo` for `Pausado`, `Cancelado` ou `Finalizado`
- Processa apenas disparos com `TipoDisparo = apioficial`
- Intervalo padrão de **2 segundos** entre envios (`SEND_INTERVAL_MS`)

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `SUPABASE_URL` | Sim | — | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim | — | **service_role** legada (`eyJ...`) ou **secret key** nova (`sb_secret_...`) |
| `META_GRAPH_API_VERSION` | Não | `v25.0` | Versão da Graph API |
| `PORT` | Não | `3080` | Porta do `/health` |
| `SEND_INTERVAL_MS` | Não | `2000` | Pausa entre envios |
| `POLL_IDLE_MS` | Não | `2000` | Pausa quando fila vazia |
| `MAX_RETRIES` | Não | `3` | Retentativas em erro transitório |

## Contrato das tabelas

### `SAAS_Detalhes_Disparos`

| Coluna | Uso |
|--------|-----|
| `Mensagem` | ID (`SAAS_Templates_Meta.id`) |
| `KeyRedis` | URL pública da mídia (header), quando o template tiver mídia |
| `idConexao` | Conexão API Oficial |
| `idContato` | Telefone via `SAAS_Contatos` |
| `Status` | `pending` → `processing` → `sent` / `failed` |

> Variáveis do template **não** vão no `Payload` do detalhe. O worker lê sempre de `SAAS_Templates_Meta`.

### `SAAS_Templates_Meta` — `variaveisCampos`

Fonte: `componentes.variaveisCampos` (prioridade) ou coluna `variaveisCampos`.

```json
{
  "componentes": [ /* array da Meta */ ],
  "variaveisCampos": {
    "body": { "1": "nome", "2": 6 },
    "header": {},
    "buttons": [{ "index": 0, "fieldId": "email" }]
  }
}
```

- `"1": "nome"` ou `"email"` → campo padrão de `SAAS_Contatos` (colunas `nome`, `email`)
- `"2": 6` → campo personalizado **id 6** (`SAAS_Valores_Campos_Personalizados`)
- Botões: `fieldId`, `campoId` ou `campoPadrao` aceitam id numérico ou `"nome"` / `"email"`

Mídia do header: URL em `KeyRedis` do detalhe (por contato/campanha).

### Chat (SAAS_Mensagens)

Após envio com sucesso, o worker grava a mensagem no chat via `f_meta_salvar_mensagem_chat`:
- Vincula à conversa do telefone + conexão
- Texto: body do template com variáveis resolvidas (+ header texto e footer)
- `arquivoUrl`: `KeyRedis` quando o template tem header de mídia
- `tipoMensagem`: `conversation` (só texto) ou `imageMessage` / `videoMessage` / `audioMessage` / `documentMessage`

### Telefone BR (nono dígito)

O worker escolhe **um** formato antes de enviar (não dispara com e sem 9):

| Tipo | Exemplo cadastro | Envia como |
|------|------------------|------------|
| Celular sem 9 | `554884549300` | `5548984549300` |
| Fixo | `554840423710` | `554840423710` |
| Fixo com 9 a mais | `5548940423710` | `554840423710` (remove o 9) |

Fixo = número local (após DDD) começa com **2, 3, 4 ou 5**.

Só tenta a variante alternativa se a **Meta rejeitar** o número (erro 400), nunca quando retorna sucesso.

### Retry via webhook (131026 — Message undeliverable)

Quando a Meta aceita o envio (`200` + `sent`) mas depois informa **failed** no webhook (`eventsmeta` → `f_meta_processar_evento`):

1. Localiza o detalhe pelo `wamid` em `respostaHttp.messages[0].id`
2. Volta `Status` de `sent` → `pending`
3. Grava `_phoneOverride` com o telefone alternativo (insere ou remove o 9)
4. O disparador reenvia usando só esse número
5. Se falhar de novo, marca `failed` definitivo (máximo **1 retry** por contato)

Campos em `respostaHttp`: `_webhookPhoneRetry`, `_phoneOverride`, `_phoneUsedBeforeRetry`, `_phoneUsed` (após novo envio).

## Rodar local

```bash
cp .env.example .env
# edite .env

npm install
npm start
```

Health: `http://localhost:3080/health`

## Imagem Docker (pública)

```
ghcr.io/victoreder/hublabel-disparador:latest
```

Atualizada automaticamente a cada push na `main`.

### Portainer (sem chave GitHub)

Com repositório e **package** públicos no GHCR, o cliente só precisa:

| Campo | Valor |
|--------|--------|
| **Image** | `ghcr.io/victoreder/hublabel-disparador:latest` |
| **Port** | `3080:3080` |
| **Restart** | Unless stopped |

**Env** (cada cliente usa o **próprio** Supabase):

```
SUPABASE_URL=https://projeto-do-cliente.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_do_cliente
META_GRAPH_API_VERSION=v25.0
PORT=3080
SEND_INTERVAL_MS=2000
POLL_IDLE_MS=2000
MAX_RETRIES=3
```

Não é necessário registry/token GitHub para puxar a imagem pública.

### Tornar público (admin HubLabel)

1. GitHub → repo **hublabel-disparador** → Settings → Danger zone → **Change visibility** → Public
2. GitHub → **Packages** → `hublabel-disparador` → Package settings → **Change visibility** → Public

> Repositório público **não** torna o package público automaticamente. Os dois precisam ser públicos.

## Docker (build local)

```bash
docker build -t hublabel-disparador-meta .
docker run -d --name disparador-meta --env-file .env -p 3080:3080 hublabel-disparador-meta
```

Ou com compose:

```bash
docker compose up -d --build
```

## Retentativas

- **429 / 5xx / timeout**: até 3 tentativas com backoff
- **401 / 403 / 400**: falha imediata (`failed`)

---

## Disparador Evolution (Individual + Grupos)

Worker separado na mesma imagem — **não** mexe em `apioficial`.

| Comando | Descrição |
|---------|-----------|
| `npm run start:evolution` | Cron a cada **1 min**, busca `dataEnvio` na janela e envia via Evolution |
| `npm start` | Disparador Meta (acima) |

### Env extra (Evolution)

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `EVOLUTION_BASE_URL` | Sim | URL base da Evolution (sem barra final) |
| `EVOLUTION_API_KEY` | Sim | API key global enviada no header `apikey` |

### Docker (Evolution)

```bash
docker run -d --name disparador-evolution --env-file .env \
  ghcr.io/victoreder/hublabel-disparador:latest \
  node src/workers/evolution.js
```

Ou `docker compose up -d` (sobe Meta + Evolution).

---

## Telas e ações (antes no n8n)

O serviço `disparador-inbound` (`node src/inbound.js`) serve **todas as telas** do sistema e as **ações** que antes rodavam no workflow n8n `[SAAS] HUBLABEL` — nas mesmas URLs (`BACK_URL/<slug>`, ex.: `https://webhook2.victoreder.com.br/webhook/login`).

### Telas

- HTML em `public/pages/<slug>.html` → `GET BACK_URL/<slug>` (25 telas + `pv.html`, padrão da página de vendas).
- Valores por cliente viram placeholders preenchidos ao servir: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BACK_URL` e `EVOLUTION_BASE_URL` vêm da stack.
- **White-label** (nome, cor, telefone de suporte, logo, favicon) vem da tabela `SAAS_Personalizacao` e é aplicado no servidor — a tela já chega personalizada, sem piscar. A aba *Personalização* do admin grava nela (`POST /personalizar-saas`). Vídeos continuam em `SAAS_VideosAjuda`.
- Para reextrair as telas de um export do n8n: `npm run extrair-telas -- caminho/do/workflow.json`.

### Ações

| Rota (POST) | O que faz |
|---|---|
| `/uploadmedia` | Upload de mídia para o S3 → `{ link }` |
| `/usuario-gratis` | Cadastro grátis (plano `PLANO_GRATIS_ID`, `PLANO_GRATIS_DIAS` dias) |
| `/criar-usuario` | Admin cria cliente (plano e vencimento informados) |
| `/adicionar-usuario` | Adiciona membro na conta |
| `/excluir-conta` | Remove o usuário do Supabase Auth |
| `/testar-openai`, `/criar-instrucao`, `/gerarmensagem-ia` | IA (chave em `SAAS_Config_IA`) |
| `/sincronizar-supabase`, `/email-supabase` | SMTP / e-mail de reset no Auth do Supabase (via PAT) |
| `/enviar-teste-email` | Teste de SMTP |
| `/enviar-template` | Envia template da API Oficial pelo chat/CRM |
| `/token?id=` | Webhook de leads (`SAAS_Webhook`): teste salva payload; ativo cria contato e manda a mensagem padrão |
| `/integracao?id=` | Gateway de pagamento (`SAAS_IntegracaoPagamento`): cria/renova usuário e envia boas-vindas |
| `/criar-pv`, `/personalizar-pv`, `/personalizar-pagina`, `GET /buscar-pv`, `GET /pv` | Página de vendas (`SAAS_PaginaVendas`) |

### Segurança das ações

As telas recebem um script (injetado pelo servidor) que manda o token da sessão do Supabase no header `X-Hub-Session` em toda chamada às rotas protegidas. O servidor valida o token no Supabase Auth e confere o usuário em `SAAS_Usuarios`. A lista fica em `ROTAS_PROTEGIDAS` (`src/inbound/auth/autenticar.js`):

| Nível | Rotas |
|---|---|
| Super admin (`super_admin = true`) | `/criar-usuario`, `/excluir-conta`, `/personalizar-saas`, `/criar-pv`, `/personalizar-pv`, `/personalizar-pagina`, `/sincronizar-supabase`, `/email-supabase`, `/alterar-credencial-smtp` |
| Admin da conta (`funcao = 'admin'`) | `/adicionar-usuario` — o membro entra sempre na conta de quem está logado |
| Usuário logado, conta ativa | `/uploadmedia`, `/gerarmensagem-ia`, `/criar-instrucao`, `/testar-openai`, `/enviar-teste-email`, `/enviar-template` (só conexão/contato da própria conta), `/inserir-conhecimento` |
| Público | telas, `/pv`, `/buscar-pv`, `/usuario-gratis` (limite por IP; `CADASTRO_GRATIS_ATIVO=false` desliga), `/token` e `/integracao` (id secreto na URL + limite por IP) |

Integrações externas sem tela podem chamar as rotas protegidas com o header `x-api-key: <HUB_API_KEY>` (vale como super admin).

### Implantação

1. Rodar `scripts/migracao-n8n-telas-acoes.sql` no SQL Editor do Supabase (uma vez).
2. Na stack, adicionar `SUPABASE_ANON_KEY` ao `disparador-inbound` e apontar o domínio inteiro para ele (veja `portainer-stack.example.yml` — um único router `Host(...)`, sem StripPrefix).
3. Remover o router do n8n desse domínio (senão os dois disputam o mesmo `Host`).
