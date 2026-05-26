const crypto = require("crypto");

function getConfig() {
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
      "Defina FACEBOOK_APP_ID, FACEBOOK_APP_SECRET e STATE_SECRET nas variaveis de ambiente."
    );
  }
  if (!ALLOWED_RETURN_ORIGINS.length) {
    throw new Error("Defina ALLOWED_RETURN_ORIGINS nas variaveis de ambiente.");
  }

  return {
    FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET,
    REDIRECT_URI,
    STATE_SECRET,
    OAUTH_SCOPES,
    STATE_TTL_SECONDS,
    ALLOWED_RETURN_ORIGINS
  };
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

function signState(payload, secret) {
  const payloadEncoded = b64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

function verifyState(state, secret) {
  if (!state || !state.includes(".")) return null;
  const [payloadEncoded, signature] = state.split(".");
  if (!payloadEncoded || !signature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("base64url");

  if (signature.length !== expectedSignature.length) return null;

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

  if (!payload?.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin || typeof origin !== "string") return false;
  try {
    const normalized = new URL(origin).origin;
    return allowedOrigins.includes(normalized);
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

module.exports = {
  getConfig,
  signState,
  verifyState,
  isAllowedOrigin,
  normalizeOrigin,
  renderDonePage
};

