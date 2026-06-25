# Workflows n8n — Meta WhatsApp

Integração com tabelas **SAAS** do `sql.sql`. Busca/gravação via nó **Supabase** (credencial `Supabase [SAAS]`) ou RPC HTTP (service role).

## Tabelas usadas

| Tabela | Uso |
|--------|-----|
| `SAAS_Conexões` | Token, WABA, phone_number_id, qualidade, capabilities, conta, alertas, pagamento |
| `SAAS_Templates_Meta` | Templates (componentes JSONB, status, qualidade, categoria) |
| `SAAS_Conversas_Agentes` + `SAAS_Mensagens` | Chat unificado (inbound webhook + outbound API) |

## RPC Supabase (executar migration no `sql.sql`)

| Função | Uso |
|--------|-----|
| `f_meta_processar_evento(jsonb)` | Webhook `eventsmeta` — nó **Postgres** executeQuery |
| `f_meta_salvar_mensagem_chat(...)` | Salva mensagem no chat (inbound/outbound) |
| `f_meta_salvar_mensagem_midia_job(jsonb)` | Salva mensagem de mídia com `arquivoUrl` (S3) |

## Configuração

1. Execute a migration Meta no final do `sql.sql` no Supabase
2. Importe os JSON da pasta `n8n/`
3. Ative os workflows (Production)
4. Em cada nó **Supabase**, vincule a credencial **Supabase [SAAS]**
5. Configure **VARIAVEIS** / **VARIAVEIS EVENTOS** (Meta App ID/Secret/Verify Token)
6. Vincule credencial **Postgres SAAS** no nó **PROCESSAR EVENTO** (`eventsmeta`)
7. Em `enviar-mensagem`, configure `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (ou migre para Postgres depois)

## Identificador

Use `conexaoId` (BIGINT — `SAAS_Conexões.id`) em todos os fluxos após conectar.

## URLs

Base: `https://n8n2.victoreder.com.br`

| Workflow | Path |
|----------|------|
| Conectar Token | `/webhook/meta-token` |
| Consultar Conexão | `/webhook/meta-consultar-conexao` |
| Renovar Token | `/webhook/meta-renovar-token` |
| Criar Template | `/webhook/meta-criar-template` |
| Listar Templates | `/webhook/meta-listar-templates` |
| Enviar Mensagem | `/webhook/meta-enviar-mensagem` |
| Events Meta | `/webhook/eventsmeta` |

Webhook Meta (proxy): `https://back.victoreder.com.br/eventsmeta`

---

## Events Meta — fields tratados

| Field | Onde salva |
|-------|------------|
| `messages` (texto) | `SAAS_Mensagens` + `SAAS_Conversas_Agentes` |
| `messages` (mídia) | Download Meta → S3 → `SAAS_Mensagens.arquivoUrl` |
| `message_template_status_update` | `SAAS_Templates_Meta.status` |
| `message_template_quality_update` | `SAAS_Templates_Meta.qualidade` |
| `template_category_update` | `SAAS_Templates_Meta.categoria` |
| `phone_number_quality_update` | `SAAS_Conexões` (qualidade do número) |
| `business_capability_update` | `SAAS_Conexões` (limites messaging) |
| `account_update` | `SAAS_Conexões.metaAccountUpdate` |
| `account_alerts` | `SAAS_Conexões.metaUltimoAlerta` |
| `payment_configuration_update` | `SAAS_Conexões.metaPagamento` (JSONB array) |

---

## Conectar Token → `SAAS_Conexões`

Atualizar conexão existente:
```json
{
  "conexaoId": 123,
  "code": "AQD...",
  "waba_id": "...",
  "phone_number_id": "...",
  "business_id": "...",
  "NomeConexao": "WhatsApp Principal"
}
```

Criar nova:
```json
{
  "contaId": "uuid-conta",
  "code": "AQD...",
  "waba_id": "...",
  "phone_number_id": "...",
  "business_id": "...",
  "NomeConexao": "WhatsApp Principal"
}
```

---

## Consultar / Renovar / Template / Enviar

Todos começam com nó **DADOS CONEXAO**:

```json
{ "operation": "get", "tableId": "SAAS_Conexões", "filters": { "conditions": [{ "keyName": "id", "keyValue": "={{ conexaoId }}" }] } }
```

Exemplo enviar template:
```json
{
  "conexaoId": 123,
  "to": "5511999999999",
  "type": "template",
  "template": {
    "name": "boas_vindas",
    "language": { "code": "pt_BR" },
    "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "João" }] }]
  }
}
```

Exemplo texto (janela 24h):
```json
{
  "conexaoId": 123,
  "to": "5511999999999",
  "type": "text",
  "text": { "body": "Olá!" }
}
```

Mensagens enviadas são gravadas em `SAAS_Mensagens` (mesmo chat do atendimento).
