# HubLabel Meta OAuth Broker

Broker OAuth centralizado para usar uma unica `redirect_uri` da Meta:

- `https://auth.hublabel.com.br/oauth/meta/callback`

## Objetivo

Intermediario entre whitelabels e Meta/WhatsApp:

- `return_origin` identifica o whitelabel (qualquer dominio http/https se allowlist vazia)
- `state` assinado com HMAC + expiracao
- `client_secret` apenas no backend
- token longo (~60d) + WABA/phone enviados via POST ao backend do whitelabel

## Modos OAuth

| Modo | Env | Quando usar |
|------|-----|-------------|
| **embedded** (padrao) | `META_OAUTH_MODE=embedded` | Multi-whitelabel, App Review WhatsApp, Tech Provider |
| **classic** | `META_OAUTH_MODE=classic` | OAuth `dialog/oauth` + scopes (apos permissoes aprovadas) |

Para App Review de WhatsApp multi-tenant, use **embedded**.

## Rotas

- `GET /oauth/meta/start?return_origin=https://cliente.com`
  - valida `return_origin`
  - assina `state`
  - redireciona para Meta (embedded ou classic)

- `GET /oauth/meta/callback`
  - valida `state`
  - troca `code` -> token curto -> **token longo**
  - busca `business_id`, `waba_id`, `phone_number_id`
- **POST** para `{return_origin}/token-apioficial` (configuravel)
- Redireciona para `{return_origin}/conexoes-api?meta_oauth=ok|erro`

- `GET /health`

## Contrato POST whitelabel

O broker envia para `{return_origin}/token-apioficial` (padrao):

```json
{
  "access_token": "...",
  "expires_in": 5184000,
  "business_id": "123",
  "waba_id": "456",
  "phone_number_id": "789"
}
```

Header de assinatura:

```
X-HubLabel-Signature: HMAC-SHA256 hex do body JSON usando STATE_SECRET
```

O whitelabel deve validar a assinatura, salvar no banco e responder `200`.

## Exemplo no whitelabel (mesma janela)

```html
<script>
  function conectarWhatsApp() {
    const returnOrigin = encodeURIComponent(window.location.origin);
    window.location.href =
      "https://auth.hublabel.com.br/oauth/meta/start?return_origin=" +
      returnOrigin;
  }

  // Em /conexoes-api, ao carregar:
  const params = new URLSearchParams(window.location.search);
  if (params.get("meta_oauth") === "ok") {
    // sucesso — dados ja foram POSTados em /token-apioficial
    history.replaceState({}, "", "/conexoes-api");
  }
  if (params.get("meta_oauth") === "erro") {
    console.error("OAuth falhou:", params.get("meta_oauth_reason"));
  }
</script>
```

## App Review Meta (WhatsApp)

Cadastre no app Meta:

- Redirect URI: `https://auth.hublabel.com.br/oauth/meta/callback`
- Privacy Policy: `https://auth.hublabel.com.br/politica-de-privacidade`
- Terms: `https://auth.hublabel.com.br/termos-de-uso`

Permissoes tipicas:

- `whatsapp_business_management`
- `whatsapp_business_messaging`
- `business_management`

Grave screencast: whitelabel abre auth -> Meta onboarding -> callback -> mensagem recebida/enviada.

## Deploy na Vercel

App Express em `app.js`, exportado por `index.js`.

Local: `npm install` e `npm run dev`.

## Configuracao

1. Copie `.env.example` para `.env`
2. Preencha `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `STATE_SECRET`
3. `ALLOWED_RETURN_ORIGINS` vazio = aceita qualquer whitelabel (http/https)
