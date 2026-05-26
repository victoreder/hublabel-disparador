const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.disable("x-powered-by");
const port = Number(process.env.PORT || 3000);

const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || "";
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || "";
const REDIRECT_URI =
  process.env.META_REDIRECT_URI ||
  "https://auth.hublabel.com.br/oauth/meta/callback";
const STATE_SECRET = process.env.STATE_SECRET || "";
const OAUTH_SCOPES =
  process.env.META_OAUTH_SCOPES ||
  "whatsapp_business_management,whatsapp_business_messaging";
const STATE_TTL_SECONDS = Number(process.env.STATE_TTL_SECONDS || 600);
const ALLOWED_RETURN_ORIGINS = (process.env.ALLOWED_RETURN_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET || !STATE_SECRET) {
  throw new Error(
    "Defina FACEBOOK_APP_ID, FACEBOOK_APP_SECRET e STATE_SECRET no .env."
  );
}

if (!ALLOWED_RETURN_ORIGINS.length) {
  throw new Error("Defina ALLOWED_RETURN_ORIGINS no .env.");
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signState(payload) {
  const payloadEncoded = b64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", STATE_SECRET)
    .update(payloadEncoded)
    .digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

function verifyState(state) {
  if (!state || !state.includes(".")) return null;
  const [payloadEncoded, signature] = state.split(".");
  if (!payloadEncoded || !signature) return null;
  const expectedSignature = crypto
    .createHmac("sha256", STATE_SECRET)
    .update(payloadEncoded)
    .digest("base64url");

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  const validSignature = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
  if (!validSignature) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadEncoded));
  } catch {
    return null;
  }

  if (!payload?.exp || Date.now() / 1000 > payload.exp) {
    return null;
  }
  return payload;
}

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  try {
    const normalized = new URL(origin).origin;
    return ALLOWED_RETURN_ORIGINS.includes(normalized);
  } catch {
    return false;
  }
}

function normalizeOrigin(origin) {
  return new URL(origin).origin;
}

function renderDonePage({ origin, ok, data }) {
  const payload = JSON.stringify({
    type: ok ? "META_OAUTH_OK" : "META_OAUTH_ERROR",
    ...data
  });
  const escapedOrigin = JSON.stringify(origin);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${ok ? "Conexao concluida" : "Falha na conexao"}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
  </style>
</head>
<body>
  <h2>${ok ? "Conexao concluida." : "Nao foi possivel concluir."}</h2>
  <p>${ok ? "Voce ja pode voltar para o sistema." : "Feche esta janela e tente novamente."}</p>
  <script>
    (function () {
      const targetOrigin = ${escapedOrigin};
      const message = ${payload};
      if (window.opener && targetOrigin) {
        window.opener.postMessage(message, targetOrigin);
      }
      setTimeout(() => window.close(), 250);
    })();
  </script>
</body>
</html>`;
}

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "meta-oauth-broker" });
});

app.get("/oauth/meta/start", (req, res) => {
  const returnOrigin = req.query.return_origin;
  if (typeof returnOrigin !== "string" || !isAllowedOrigin(returnOrigin)) {
    return res.status(400).json({
      error:
        "return_origin invalido. Configure na allowlist ALLOWED_RETURN_ORIGINS."
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const returnMode = req.query.return_mode === "redirect" ? "redirect" : "post_message";
  const normalizedOrigin = normalizeOrigin(returnOrigin);
  const state = signState({
    return_origin: normalizedOrigin,
    return_mode: returnMode,
    nonce: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + STATE_TTL_SECONDS
  });

  const params = new URLSearchParams({
    client_id: FACEBOOK_APP_ID,
    redirect_uri: REDIRECT_URI,
    state,
    response_type: "code",
    scope: OAUTH_SCOPES
  });

  const oauthUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
  return res.redirect(oauthUrl);
});

app.get("/oauth/meta/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (typeof state !== "string") {
    return res.status(400).send(
      renderDonePage({
        origin: "",
        ok: false,
        data: { reason: "missing_state" }
      })
    );
  }

  const parsedState = verifyState(state);
  if (!parsedState || !isAllowedOrigin(parsedState.return_origin)) {
    return res.status(400).send(
      renderDonePage({
        origin: "",
        ok: false,
        data: { reason: "invalid_or_expired_state" }
      })
    );
  }

  const returnOrigin = parsedState.return_origin;

  if (typeof error === "string") {
    return res.status(400).send(
      renderDonePage({
        origin: returnOrigin,
        ok: false,
        data: {
          reason: "meta_oauth_error",
          error,
          error_description: typeof errorDescription === "string" ? errorDescription : ""
        }
      })
    );
  }

  if (typeof code !== "string") {
    return res.status(400).send(
      renderDonePage({
        origin: returnOrigin,
        ok: false,
        data: { reason: "missing_code" }
      })
    );
  }

  try {
    const tokenParams = new URLSearchParams({
      client_id: FACEBOOK_APP_ID,
      client_secret: FACEBOOK_APP_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    });

    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?${tokenParams.toString()}`;
    const tokenResponse = await fetch(tokenUrl, { method: "GET" });
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.error) {
      return res.status(400).send(
        renderDonePage({
          origin: returnOrigin,
          ok: false,
          data: {
            reason: "token_exchange_failed",
            error: tokenData?.error?.message || "Falha na troca de token"
          }
        })
      );
    }

    if (parsedState.return_mode === "redirect") {
      const redirectUrl = new URL("/oauth/meta/complete", returnOrigin);
      redirectUrl.searchParams.set("status", "ok");
      redirectUrl.searchParams.set("access_token", tokenData.access_token || "");
      redirectUrl.searchParams.set("token_type", tokenData.token_type || "");
      redirectUrl.searchParams.set("expires_in", String(tokenData.expires_in || ""));
      return res.redirect(redirectUrl.toString());
    }

    return res.send(
      renderDonePage({
        origin: returnOrigin,
        ok: true,
        data: {
          access_token: tokenData.access_token,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in
        }
      })
    );
  } catch {
    return res.status(500).send(
      renderDonePage({
        origin: returnOrigin,
        ok: false,
        data: { reason: "internal_error" }
      })
    );
  }
});

app.listen(port, () => {
  console.log(`OAuth broker online em http://localhost:${port}`);
});
