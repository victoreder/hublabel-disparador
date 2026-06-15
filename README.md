# HubLabel — Disparador Meta (API Oficial)

Worker Node.js que consome a fila `SAAS_Detalhes_Disparos` e envia mensagens via WhatsApp Cloud API (Graph API v25).

## O que faz

- Processa apenas conexões com `apiOficial = true`
- Envia **templates** (texto, mídia, botões)
- Ignora `dataEnvio` do detalhe — dispara o mais rápido possível
- Respeita apenas `DataAgendamento` do disparo para **início** da campanha
- Para imediatamente se `StatusDisparo` for `Pausado`/`pausado` ou `Cancelado`/`cancelado`
- Intervalo padrão de **2 segundos** entre envios (`SEND_INTERVAL_MS`)

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `SUPABASE_URL` | Sim | — | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim | — | Service role (bypass RLS) |
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
| `Payload` | Variáveis do template (JSON) |
| `KeyRedis` | URL pública da mídia (header) |
| `idConexao` | Conexão API Oficial |
| `idContato` | Telefone via `SAAS_Contatos` |
| `Status` | `pending` → `processing` → `sent` / `failed` |

### Exemplo de `Payload`

```json
{
  "body": ["João", "R$ 99,90"],
  "header": { "type": "image", "link": "https://exemplo.com/img.jpg" },
  "buttons": [{ "type": "url", "index": 0, "payload": "promo" }]
}
```

Se `KeyRedis` estiver preenchido, ele tem prioridade sobre `header.link` para mídia.

## Rodar local

```bash
cp .env.example .env
# edite .env

npm install
npm start
```

Health: `http://localhost:3080/health`

## Docker

```bash
docker build -t hublabel-disparador-meta .
docker run -d --name disparador-meta --env-file .env -p 3080:3080 hublabel-disparador-meta
```

Ou com compose:

```bash
docker compose up -d --build
```

## GitHub (repo separado)

```bash
cd disparador-meta
git init
git add .
git commit -m "feat: disparador WhatsApp API Oficial"
gh repo create hublabel-disparador-meta --private --source=. --push
```

## Retentativas

- **429 / 5xx / timeout**: até 3 tentativas com backoff
- **401 / 403 / 400**: falha imediata (`failed`)
