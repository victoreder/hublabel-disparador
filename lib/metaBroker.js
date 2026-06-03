const crypto = require("crypto");

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v21.0";

const DEFAULT_META_ONBOARD_EXTRAS = {
  featureType: "whatsapp_business_app_onboarding",
  sessionInfoVersion: "3",
  version: "v4",
  features: [{ name: "app_only_install" }]
};

function parseOnboardExtras(raw) {
  if (!raw) return DEFAULT_META_ONBOARD_EXTRAS;
  try {
    return JSON.parse(raw);
  } catch {
    return DEFAULT_META_ONBOARD_EXTRAS;
  }
}

function getConfig() {
  const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || "";
  const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || "";
  const REDIRECT_URI =
    process.env.META_REDIRECT_URI ||
    "https://auth.hublabel.com.br/oauth/meta/callback";
  const STATE_SECRET = process.env.STATE_SECRET || "";
  const OAUTH_SCOPES =
    process.env.META_OAUTH_SCOPES ||
    "whatsapp_business_management,whatsapp_business_messaging,business_management";
  const META_CONFIG_ID = process.env.META_CONFIG_ID || "1464159071696114";
  const META_ONBOARD_EXTRAS = parseOnboardExtras(
    process.env.META_ONBOARD_EXTRAS
  );
  const META_OAUTH_MODE =
    process.env.META_OAUTH_MODE === "classic" ? "classic" : "embedded";
  const WHITELABEL_CONNECT_PATH =
    process.env.META_WHITELABEL_CONNECT_PATH || "/api/meta/conectar";
  const STATE_TTL_SECONDS = Number(process.env.STATE_TTL_SECONDS || 600);
  const ALLOWED_RETURN_ORIGINS = (process.env.ALLOWED_RETURN_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET || !STATE_SECRET) {
    throw new Error(
      "Defina FACEBOOK_APP_ID, FACEBOOK_APP_SECRET e STATE_SECRET nas variaveis de ambiente."
    );
  }

  return {
    FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET,
    REDIRECT_URI,
    STATE_SECRET,
    OAUTH_SCOPES,
    META_CONFIG_ID,
    META_ONBOARD_EXTRAS,
    META_OAUTH_MODE,
    WHITELABEL_CONNECT_PATH,
    STATE_TTL_SECONDS,
    ALLOWED_RETURN_ORIGINS
  };
}

function buildMetaOnboardUrl({ appId, configId, redirectUri, state, extras }) {
  const params = new URLSearchParams({
    app_id: appId,
    config_id: configId,
    extras: JSON.stringify(extras || DEFAULT_META_ONBOARD_EXTRAS)
  });

  if (redirectUri) params.set("redirect_uri", redirectUri);
  if (state) params.set("state", state);

  return `https://business.facebook.com/messaging/whatsapp/onboard/?${params.toString()}`;
}

function buildClassicOAuthUrl({
  appId,
  redirectUri,
  state,
  scopes,
  configId
}) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state
  });

  if (configId) {
    params.set("config_id", configId);
  } else {
    params.set("scope", scopes);
  }

  return `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
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
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol)) return false;

    if (!allowedOrigins.length) {
      return true;
    }

    return allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function normalizeOrigin(origin) {
  return new URL(origin).origin;
}

async function graphGet(path, accessToken) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}${path}${separator}access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, { method: "GET" });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data?.error?.message || "Erro na Graph API");
  }
  return data;
}

async function exchangeCodeForToken({ appId, appSecret, redirectUri, code }) {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code
  });

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?${params.toString()}`
  );
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data?.error?.message || "Falha na troca de code por token");
  }
  return data;
}

async function exchangeLongLivedToken({ appId, appSecret, shortLivedToken }) {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken
  });

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?${params.toString()}`
  );
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data?.error?.message || "Falha na troca por token longo");
  }
  return data;
}

async function fetchWhatsAppAssets(accessToken, hints = {}) {
  if (hints.waba_id && hints.phone_number_id) {
    return {
      business_id: hints.business_id || null,
      waba_id: hints.waba_id,
      phone_number_id: hints.phone_number_id
    };
  }

  const businesses = await graphGet(
    "/me/businesses?fields=id,name",
    accessToken
  );
  const business = businesses.data?.[0];
  if (!business?.id) {
    throw new Error("Nenhuma conta Business encontrada para este usuario");
  }

  const wabaResponse = await graphGet(
    `/${business.id}/owned_whatsapp_business_accounts?fields=id,name`,
    accessToken
  );
  const waba = wabaResponse.data?.[0];
  if (!waba?.id) {
    throw new Error("Nenhuma conta WhatsApp Business (WABA) encontrada");
  }

  const phonesResponse = await graphGet(
    `/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name`,
    accessToken
  );
  const phone = phonesResponse.data?.[0];
  if (!phone?.id) {
    throw new Error("Nenhum numero WhatsApp encontrado na WABA");
  }

  return {
    business_id: business.id,
    waba_id: waba.id,
    phone_number_id: phone.id
  };
}

async function notifyWhitelabel({
  returnOrigin,
  connectPath,
  payload,
  stateSecret
}) {
  const url = new URL(connectPath, returnOrigin).toString();
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", stateSecret)
    .update(body)
    .digest("hex");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HubLabel-Signature": signature
    },
    body
  });

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body: responseBody
  };
}

function buildReturnUrl(origin, returnPath, ok, data) {
  if (!origin) return null;
  const url = new URL(returnPath || "/", origin);
  url.searchParams.set("meta_oauth", ok ? "ok" : "error");
  if (!ok && data?.reason) {
    url.searchParams.set("meta_oauth_reason", String(data.reason));
  }
  return url.toString();
}

function renderDonePage({
  origin,
  ok,
  data,
  returnMode = "redirect",
  returnPath = "/"
}) {
  const safeData = ok
    ? { reason: data?.reason || "connected" }
    : data || { reason: "unknown_error" };

  const payload = JSON.stringify({
    type: ok ? "META_OAUTH_OK" : "META_OAUTH_ERROR",
    ...safeData
  });
  const escapedOrigin = JSON.stringify(origin);
  const returnUrl = buildReturnUrl(origin, returnPath, ok, safeData);
  const escapedReturnUrl = JSON.stringify(returnUrl);
  const useRedirect = returnMode === "redirect" && returnUrl;

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
  <p>${ok ? "Redirecionando..." : "Redirecionando de volta ao sistema..."}</p>
  <script>
    (function () {
      const targetOrigin = ${escapedOrigin};
      const message = ${payload};
      const returnUrl = ${escapedReturnUrl};
      const useRedirect = ${useRedirect ? "true" : "false"};

      if (window.opener && targetOrigin) {
        try { window.opener.postMessage(message, targetOrigin); } catch (e) {}
      }

      if (useRedirect && returnUrl) {
        window.location.replace(returnUrl);
        return;
      }

      setTimeout(function () { window.close(); }, 400);
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  getConfig,
  buildMetaOnboardUrl,
  buildClassicOAuthUrl,
  signState,
  verifyState,
  isAllowedOrigin,
  normalizeOrigin,
  exchangeCodeForToken,
  exchangeLongLivedToken,
  fetchWhatsAppAssets,
  notifyWhitelabel,
  buildReturnUrl,
  renderDonePage
};
