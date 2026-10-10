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

## Imagem Docker e licenciamento

```
ghcr.io/victoreder/hublabel-disparador:latest
```

Atualizada automaticamente a cada push na `main`. O **repositório é privado**. O **package da imagem é
público**, mas a imagem contém só o código empacotado e ofuscado, e não roda sem licença válida
(`LICENCA_EMAIL` nas variáveis da stack).

- Guia do vendedor (setup, criar/revogar/transferir licenças): [`docs/LICENCIAMENTO.md`](docs/LICENCIAMENTO.md)
- Guia de instalação para o cliente: [`docs/INSTALACAO-CLIENTE.md`](docs/INSTALACAO-CLIENTE.md)
- Servidor de licenças: [`license-server/`](license-server/)

### Env de licença (obrigatórias na imagem distribuída)

| Variável | Descrição |
|----------|-----------|
| `LICENCA_EMAIL` | E-mail da compra |

Rodando do fonte (`npm start`, `npm test`) a licença não é exigida.

## Docker (build local)

O build precisa da chave pública e da URL do servidor de licenças (ver `docs/LICENCIAMENTO.md`):

```bash
docker build \
  --build-arg LICENSE_PUBLIC_KEY="..." \
  --build-arg LICENSE_SERVER_URL="https://licenca.seudominio" \
  -t hublabel-disparador-meta .
docker run -d --name disparador-meta --env-file .env -p 3080:3080 hublabel-disparador-meta
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

### Proteções contra ataque e sobrecarga (`src/inbound/seguranca/`)

| Camada | Como funciona |
|---|---|
| **Login com bloqueio** | A tela de login autentica por `POST /auth/login` (o servidor fala com o Supabase). 5 senhas erradas para o mesmo e-mail em 15 min bloqueiam o e-mail por 15 min; no máximo 10 tentativas por IP/min. |
| **Jail ("fail2ban")** | Comportamento suspeito soma pontos por IP: varredura (`/.env`, `/wp-login.php`...), login errado, sessão inválida, usuário comum tentando rota de admin, `x-api-key` errada, id de webhook inexistente, 404 e limite estourado. 30 pontos em 10 min = IP banido por 60 min (403 em tudo). |
| **Limites** | Global de 300 req/min por IP; IA 10/min por usuário; upload 30/min por usuário; teste de e-mail 20/h; cadastro grátis 5/h por IP; `/token` e `/integracao` 120/min por IP. |
| **Sobrecarga** | Rotas pesadas têm teto de execuções simultâneas (IA 4, página de vendas 1, upload 3) com fila curta → 503. Se o event loop engasgar (>250 ms), o que não é essencial recebe 503 e os webhooks da Meta/Evolution continuam sendo atendidos. Upload até 50 MB, JSON até 5 MB, timeout de requisição 120 s. |
| **Cabeçalhos/CORS** | HSTS, `nosniff`, anti-clickjacking (telas não podem ser embutidas em outro site), CORS só para o próprio domínio (`CORS_ORIGENS` para extras), erro interno sem detalhes. |

Contadores e bans ficam no Redis (`REDIS_URL`), valendo entre réplicas e após restart; sem Redis, em memória. A rede interna (Docker) e `SEGURANCA_IPS_LIBERADOS` nunca são limitados nem banidos. Webhooks da Meta/Evolution ficam fora do limite global.

> `public/pages/login.html` foi alterada depois da extração (login via `/auth/login`). Se reextrair as telas do n8n, refaça essa alteração.

### Implantação

1. Rodar `scripts/migracao-n8n-telas-acoes.sql` no SQL Editor do Supabase (uma vez).
2. Na stack, adicionar `SUPABASE_ANON_KEY` ao `disparador-inbound` e apontar o domínio inteiro para ele (veja `portainer-stack.example.yml` — um único router `Host(...)`, sem StripPrefix).
3. Remover o router do n8n desse domínio (senão os dois disputam o mesmo `Host`).
