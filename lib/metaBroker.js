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
  const META_OAUTH_MODE = (() => {
    const mode = process.env.META_OAUTH_MODE || "sdk";
    const allowed = ["sdk", "embedded", "classic", "onboard", "hosted"];
    return allowed.includes(mode) ? mode : "sdk";
  })();
  const META_SDK_VERSION = process.env.META_SDK_VERSION || "v25.0";
  const META_OAUTH_DISPLAY =
    process.env.META_OAUTH_DISPLAY === "popup" ? "popup" : "page";
  const WHITELABEL_CONNECT_PATH =
    process.env.META_WHITELABEL_CONNECT_PATH || "/token-apioficial";
  const DEFAULT_RETURN_PATH =
    process.env.META_WHITELABEL_RETURN_PATH || "/conexoes-api";
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
    META_SDK_VERSION,
    META_OAUTH_DISPLAY,
    WHITELABEL_CONNECT_PATH,
    DEFAULT_RETURN_PATH,
    STATE_TTL_SECONDS,
    ALLOWED_RETURN_ORIGINS
  };
}

function buildHostedEsCallbackUrl({
  appId,
  configId,
  redirectUri,
  state,
  extras
}) {
  const params = new URLSearchParams({
    app_id: appId,
    config_id: configId,
    extras: JSON.stringify(extras || DEFAULT_META_ONBOARD_EXTRAS),
    redirect_uri: redirectUri,
    state
  });

  return `https://business.facebook.com/messaging/hosted_es/oauth_callback/?${params.toString()}`;
}

function buildHostedEmbeddedOAuthUrl({
  appId,
  configId,
  redirectUri,
  state,
  extras,
  display = "page"
}) {
  const callbackExtras = extras || DEFAULT_META_ONBOARD_EXTRAS;
  const hostedEsCallback = buildHostedEsCallbackUrl({
    appId,
    configId,
    redirectUri,
    state,
    extras: callbackExtras
  });

  const dialogExtras = {
    featureType: "whatsapp_business_app_onboarding",
    sessionInfoVersion: "3",
    version: "v3",
    features: [{ name: "app_only_install" }],
    partner_data: "null",
    is_hosted_es: true
  };

  const oauthDialogVersion =
    process.env.META_OAUTH_DIALOG_VERSION || "v25.0";

  const params = new URLSearchParams({
    client_id: appId,
    config_id: configId,
    redirect_uri: hostedEsCallback,
    fallback_redirect_uri: hostedEsCallback,
    response_type: "code",
    state,
    display,
    extras: JSON.stringify(dialogExtras),
    override_default_response_type: "true"
  });
  params.set("auth_type", "");

  return `https://www.facebook.com/${oauthDialogVersion}/dialog/oauth?${params.toString()}`;
}

function buildEmbeddedOAuthUrl({
  appId,
  configId,
  redirectUri,
  state,
  display = "page"
}) {
  const dialogExtras = {
    featureType: "whatsapp_business_app_onboarding",
    sessionInfoVersion: "3",
    version: "v3",
    features: [{ name: "app_only_install" }]
  };

  const oauthDialogVersion =
    process.env.META_OAUTH_DIALOG_VERSION || "v25.0";

  const params = new URLSearchParams({
    client_id: appId,
    config_id: configId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    display,
    extras: JSON.stringify(dialogExtras)
  });

  return `https://www.facebook.com/${oauthDialogVersion}/dialog/oauth?${params.toString()}`;
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
  return parseReturnOrigin(origin)?.origin ?? new URL(origin).origin;
}

function joinBasePath(basePath, suffixPath) {
  const base = (basePath || "").replace(/\/$/, "");
  const suffix = suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
  return base ? `${base}${suffix}` : suffix;
}

function parseReturnOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;

    let basePath = url.pathname || "";
    if (basePath === "/" || basePath === "") {
      basePath = "";
    } else {
      basePath = basePath.replace(/\/$/, "");
    }

    return { origin: url.origin, basePath };
  } catch {
    return null;
  }
}

function resolvePathWithBase(basePath, explicitPath, defaultPath) {
  const explicit = normalizeConnectPath(explicitPath, null);
  if (explicit) return explicit;
  if (basePath) return joinBasePath(basePath, defaultPath);
  return defaultPath;
}

function normalizeConnectPath(path, fallback) {
  if (typeof path === "string" && path.startsWith("/") && path.length <= 256) {
    return path;
  }
  return fallback;
}

function resolveConnectPath({ returnPath, connectPath, defaultConnectPath }) {
  const explicit = normalizeConnectPath(connectPath, null);
  if (explicit) return explicit;

  if (typeof returnPath === "string" && returnPath.endsWith("/conexoes-api")) {
    return returnPath.replace(/\/conexoes-api$/, "/token-apioficial");
  }

  return defaultConnectPath;
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
    redirect_uri: redirectUri ?? "",
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

function getDonePageOptions(parsedState, defaultReturnPath) {
  return {
    returnMode:
      parsedState.return_mode === "post_message" ? "post_message" : "redirect",
    returnPath:
      typeof parsedState.return_path === "string"
        ? parsedState.return_path
        : defaultReturnPath
  };
}

async function completeMetaConnection({
  code,
  parsedState,
  sessionHints,
  config,
  tokenExchangeRedirectUri
}) {
  const {
    FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET,
    STATE_SECRET,
    WHITELABEL_CONNECT_PATH,
    DEFAULT_RETURN_PATH
  } = config;

  const donePageOptions = getDonePageOptions(parsedState, DEFAULT_RETURN_PATH);
  const returnOrigin = parsedState.return_origin;

  const shortToken = await exchangeCodeForToken({
    appId: FACEBOOK_APP_ID,
    appSecret: FACEBOOK_APP_SECRET,
    redirectUri: tokenExchangeRedirectUri,
    code
  });

  const longToken = await exchangeLongLivedToken({
    appId: FACEBOOK_APP_ID,
    appSecret: FACEBOOK_APP_SECRET,
    shortLivedToken: shortToken.access_token
  });

  const assets = await fetchWhatsAppAssets(longToken.access_token, {
    waba_id: sessionHints?.waba_id || null,
    phone_number_id: sessionHints?.phone_number_id || null,
    business_id: sessionHints?.business_id || null
  });

  const payload = {
    access_token: longToken.access_token,
    expires_in: longToken.expires_in || null,
    business_id: assets.business_id,
    waba_id: assets.waba_id,
    phone_number_id: assets.phone_number_id
  };

  const connectPath =
    typeof parsedState.connect_path === "string"
      ? parsedState.connect_path
      : resolveConnectPath({
          returnPath: parsedState.return_path,
          connectPath: null,
          defaultConnectPath: resolvePathWithBase(
            parsedState.return_base_path || "",
            null,
            WHITELABEL_CONNECT_PATH
          )
        });

  const notifyResult = await notifyWhitelabel({
    returnOrigin,
    connectPath,
    payload,
    stateSecret: STATE_SECRET
  });

  if (!notifyResult.ok) {
    return {
      ok: false,
      returnOrigin,
      donePageOptions,
      error: {
        reason: "whitelabel_notify_failed",
        status: notifyResult.status,
        connect_url: new URL(connectPath, returnOrigin).toString()
      }
    };
  }

  return {
    ok: true,
    returnOrigin,
    donePageOptions,
    payload
  };
}

function renderEmbeddedSignupPage({
  appId,
  configId,
  state,
  sdkVersion,
  completeUrl
}) {
  const safeAppId = JSON.stringify(appId);
  const safeConfigId = JSON.stringify(configId);
  const safeState = JSON.stringify(state);
  const safeCompleteUrl = JSON.stringify(completeUrl);
  const safeSdkVersion = JSON.stringify(sdkVersion);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conectar WhatsApp — HubLabel</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #0b1220;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      max-width: 420px;
      width: 100%;
      background: #111827;
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 32px;
      text-align: center;
    }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #94a3b8; font-size: 0.95rem; margin: 0 0 20px; }
    .status { font-size: 0.9rem; color: #94a3b8; min-height: 1.5em; }
    button {
      background: #1877f2;
      border: 0;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      padding: 12px 24px;
      width: 100%;
    }
    button:disabled { opacity: 0.6; cursor: wait; }
    .error { color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WhatsApp API Oficial</h1>
    <p id="subtitle">Aguarde, abrindo o cadastro incorporado da Meta...</p>
    <p class="status" id="status"></p>
    <button type="button" id="btnRetry" style="display:none" onclick="launchWhatsAppSignup()">Tentar novamente</button>
  </div>
  <script>
    window.fbAsyncInit = function () {
      FB.init({
        appId: ${safeAppId},
        autoLogAppEvents: true,
        xfbml: true,
        version: ${safeSdkVersion}
      });
      launchWhatsAppSignup();
    };
  </script>
  <script async defer crossorigin="anonymous" src="https://connect.facebook.net/pt_BR/sdk.js"></script>
  <script>
    (function () {
      const CONFIG_ID = ${safeConfigId};
      const STATE = ${safeState};
      const COMPLETE_URL = ${safeCompleteUrl};
      let sessionData = null;
      let pendingCode = null;
      let submitted = false;

      const statusEl = document.getElementById("status");
      const subtitleEl = document.getElementById("subtitle");
      const btnRetry = document.getElementById("btnRetry");

      function setStatus(msg, isError) {
        statusEl.textContent = msg;
        statusEl.className = "status" + (isError ? " error" : "");
      }

      window.addEventListener("message", function (event) {
        if (event.origin !== "https://www.facebook.com") return;
        try {
          const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return;

          if (payload.event === "FINISH" && payload.data) {
            sessionData = payload.data;
            trySubmit();
            return;
          }

          if (payload.event === "CANCEL") {
            setStatus("Cadastro cancelado.", true);
            subtitleEl.textContent = "Voce pode tentar novamente.";
            btnRetry.style.display = "block";
          }
        } catch (e) {}
      });

      function trySubmit() {
        if (submitted || !pendingCode) return;
        submitted = true;
        setStatus("Finalizando conexao...");

        fetch(COMPLETE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: pendingCode,
            state: STATE,
            session: sessionData
          })
        })
          .then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
          .then(function (_ref) {
            var res = _ref.res;
            var body = _ref.body;
            if (body.redirect) {
              window.location.replace(body.redirect);
              return;
            }
            submitted = false;
            setStatus(body.error || "Falha ao concluir.", true);
            subtitleEl.textContent = "Nao foi possivel concluir.";
            btnRetry.style.display = "block";
          })
          .catch(function () {
            submitted = false;
            setStatus("Erro de rede. Tente novamente.", true);
            btnRetry.style.display = "block";
          });
      }

      window.launchWhatsAppSignup = function () {
        if (typeof FB === "undefined") {
          setStatus("Carregando SDK da Meta...", false);
          return;
        }

        submitted = false;
        pendingCode = null;
        sessionData = null;
        btnRetry.style.display = "none";
        subtitleEl.textContent = "Conclua o cadastro na janela da Meta.";
        setStatus("Abrindo cadastro incorporado...");

        FB.login(
          function (response) {
            if (response.authResponse && response.authResponse.code) {
              pendingCode = response.authResponse.code;
              setTimeout(trySubmit, 400);
              setTimeout(function () {
                if (!submitted) trySubmit();
              }, 3500);
              return;
            }
            setStatus("Login cancelado ou nao autorizado.", true);
            subtitleEl.textContent = "Voce pode tentar novamente.";
            btnRetry.style.display = "block";
          },
          {
            config_id: CONFIG_ID,
            response_type: "code",
            override_default_response_type: true,
            extras: {
              version: "v4",
              featureType: "whatsapp_business_app_onboarding"
            }
          }
        );
      };
    })();
  </script>
</body>
</html>`;
}

function buildReturnUrl(origin, returnPath, ok, data) {
  if (!origin) return null;
  const url = new URL(returnPath || "/conexoes-api", origin);
  url.searchParams.set("meta_oauth", ok ? "ok" : "erro");
  if (!ok && data?.reason) {
    url.searchParams.set("meta_oauth_reason", String(data.reason));
  }
  if (!ok && data?.status) {
    url.searchParams.set("meta_oauth_status", String(data.status));
  }
  return url.toString();
}

function renderDonePage({
  origin,
  ok,
  data,
  returnMode = "redirect",
  returnPath = "/conexoes-api"
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
  buildEmbeddedOAuthUrl,
  buildHostedEmbeddedOAuthUrl,
  buildClassicOAuthUrl,
  signState,
  verifyState,
  isAllowedOrigin,
  normalizeOrigin,
  parseReturnOrigin,
  joinBasePath,
  resolvePathWithBase,
  normalizeConnectPath,
  resolveConnectPath,
  exchangeCodeForToken,
  exchangeLongLivedToken,
  fetchWhatsAppAssets,
  notifyWhitelabel,
  getDonePageOptions,
  completeMetaConnection,
  renderEmbeddedSignupPage,
  buildReturnUrl,
  renderDonePage
};
