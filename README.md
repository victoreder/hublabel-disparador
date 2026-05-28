# HubLabel Meta OAuth Broker

Broker OAuth centralizado para usar uma unica `redirect_uri` da Meta:

- `https://auth.hublabel.com.br/oauth/meta/callback`

## Objetivo

Servir como intermediario entre whitelabels e Meta/Facebook, sem banco e sem tenant, com validacao minima de seguranca:

- `return_origin` com allowlist
- `state` assinado e com expiracao
- `client_secret` apenas no backend

## Rotas

- `GET /oauth/meta/start?return_origin=https://cliente.com`
  - valida `return_origin`
  - assina `state`
  - redireciona para o OAuth da Meta
  - por padrao usa `postMessage`; opcional `&return_mode=redirect`

- `GET /oauth/meta/callback`
  - valida `state`
  - troca `code` por `access_token`
  - `post_message` (padrao): retorna HTML que envia `postMessage` para o whitelabel e fecha popup
  - `redirect`: redireciona para `https://seu-whitelabel.com/oauth/meta/complete?...`

- `GET /health`
  - status basico

## Deploy na Vercel

Esse projeto usa Vercel Functions em `api/*`, arquivos estáticos em `public/` e `vercel.json` com rotas:

- `/health` -> `/api/health`
- `/oauth/meta/start` -> `/api/oauth/meta/start`
- `/oauth/meta/callback` -> `/api/oauth/meta/callback`
- demais URLs -> arquivos em `public/` (home, termos, privacidade)

Para desenvolvimento local: `npm install` e `npm run dev` (usa `dev-server.js`).

Na Vercel, use **Framework Preset: Other**, sem Build Command e sem Output Directory customizado.

## Páginas públicas

- Home: `https://auth.hublabel.com.br/`
- Política de Privacidade: `https://auth.hublabel.com.br/politica-de-privacidade`
- Termos de Uso: `https://auth.hublabel.com.br/termos-de-uso`
- Health (API): `https://auth.hublabel.com.br/health`

Use as URLs de política e termos no cadastro do app na Meta (Privacy Policy URL e Terms of Service URL).

## Configuracao

1. Copie `.env.example` para `.env`
2. Preencha os valores reais

## Executar

```bash
npm install
npm run start
```

## Exemplo no whitelabel

```html
<script>
  function conectarFacebook() {
    const returnOrigin = encodeURIComponent(window.location.origin);
    const url =
      "https://auth.hublabel.com.br/oauth/meta/start?return_origin=" +
      returnOrigin;
    window.open(url, "meta_oauth", "width=600,height=700");
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== "https://auth.hublabel.com.br") return;
    if (event.data?.type === "META_OAUTH_OK") {
      // Envie para o backend do whitelabel salvar de forma segura
      console.log("Token recebido:", event.data.access_token);
      return;
    }
    if (event.data?.type === "META_OAUTH_ERROR") {
      console.error("Falha no OAuth:", event.data);
    }
  });
</script>
```
