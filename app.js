const path = require("path");
const crypto = require("crypto");
const express = require("express");
const {
  getConfig,
  signState,
  verifyState,
  isAllowedOrigin,
  normalizeOrigin,
  renderDonePage,
  buildMetaOnboardUrl,
  buildEmbeddedOAuthUrl,
  buildClassicOAuthUrl,
  exchangeCodeForToken,
  exchangeLongLivedToken,
  fetchWhatsAppAssets,
  notifyWhitelabel
} = require("./lib/metaBroker");

function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_, res) => {
    res.json({ ok: true, service: "meta-oauth-broker" });
  });

  app.get("/oauth/meta/start", (req, res) => {
    const {
      FACEBOOK_APP_ID,
      REDIRECT_URI,
      STATE_SECRET,
      OAUTH_SCOPES,
      META_CONFIG_ID,
      META_ONBOARD_EXTRAS,
      META_OAUTH_MODE,
      META_OAUTH_DISPLAY,
      STATE_TTL_SECONDS,
      ALLOWED_RETURN_ORIGINS,
      DEFAULT_RETURN_PATH
    } = getConfig();

    const returnOrigin = req.query.return_origin;
    if (
      typeof returnOrigin !== "string" ||
      !isAllowedOrigin(returnOrigin, ALLOWED_RETURN_ORIGINS)
    ) {
      return res.status(400).json({
        error: "return_origin invalido."
      });
    }

    const returnMode =
      req.query.return_mode === "post_message" ? "post_message" : "redirect";
    const returnPath =
      typeof req.query.return_path === "string" && req.query.return_path.startsWith("/")
        ? req.query.return_path
        : DEFAULT_RETURN_PATH;

    const now = Math.floor(Date.now() / 1000);
    const normalizedOrigin = normalizeOrigin(returnOrigin);
    const state = signState(
      {
        return_origin: normalizedOrigin,
        return_mode: returnMode,
        return_path: returnPath,
        nonce: crypto.randomBytes(16).toString("hex"),
        iat: now,
        exp: now + STATE_TTL_SECONDS
      },
      STATE_SECRET
    );

    const authUrl = (() => {
      if (META_OAUTH_MODE === "classic") {
        return buildClassicOAuthUrl({
          appId: FACEBOOK_APP_ID,
          redirectUri: REDIRECT_URI,
          state,
          scopes: OAUTH_SCOPES,
          configId: META_CONFIG_ID
        });
      }

      if (META_OAUTH_MODE === "onboard") {
        return buildMetaOnboardUrl({
          appId: FACEBOOK_APP_ID,
          configId: META_CONFIG_ID,
          redirectUri: REDIRECT_URI,
          state,
          extras: META_ONBOARD_EXTRAS
        });
      }

      return buildEmbeddedOAuthUrl({
        appId: FACEBOOK_APP_ID,
        configId: META_CONFIG_ID,
        redirectUri: REDIRECT_URI,
        state,
        extras: META_ONBOARD_EXTRAS,
        display: META_OAUTH_DISPLAY
      });
    })();

    return res.redirect(authUrl);
  });

  app.get("/oauth/meta/callback", async (req, res) => {
    const {
      FACEBOOK_APP_ID,
      FACEBOOK_APP_SECRET,
      REDIRECT_URI,
      STATE_SECRET,
      WHITELABEL_CONNECT_PATH,
      ALLOWED_RETURN_ORIGINS,
      DEFAULT_RETURN_PATH
    } = getConfig();

    const {
      code,
      state,
      error,
      error_description: errorDescription,
      waba_id: wabaIdHint,
      phone_number_id: phoneNumberIdHint,
      business_id: businessIdHint
    } = req.query;

    if (typeof state !== "string") {
      return res.status(400).send(
        renderDonePage({
          origin: "",
          ok: false,
          data: { reason: "missing_state" }
        })
      );
    }

    const parsedState = verifyState(state, STATE_SECRET);
    if (
      !parsedState ||
      !isAllowedOrigin(parsedState.return_origin, ALLOWED_RETURN_ORIGINS)
    ) {
      return res.status(400).send(
        renderDonePage({
          origin: "",
          ok: false,
          data: { reason: "invalid_or_expired_state" }
        })
      );
    }

    const returnOrigin = parsedState.return_origin;
    const donePageOptions = {
      returnMode: parsedState.return_mode === "post_message" ? "post_message" : "redirect",
      returnPath:
        typeof parsedState.return_path === "string"
          ? parsedState.return_path
          : DEFAULT_RETURN_PATH
    };

    if (typeof error === "string") {
      return res.status(400).send(
        renderDonePage({
          origin: returnOrigin,
          ok: false,
          data: {
            reason: "meta_oauth_error",
            error,
            error_description:
              typeof errorDescription === "string" ? errorDescription : ""
          },
          ...donePageOptions
        })
      );
    }

    if (typeof code !== "string") {
      return res.status(400).send(
        renderDonePage({
          origin: returnOrigin,
          ok: false,
          data: { reason: "missing_code" },
          ...donePageOptions
        })
      );
    }

    try {
      const shortToken = await exchangeCodeForToken({
        appId: FACEBOOK_APP_ID,
        appSecret: FACEBOOK_APP_SECRET,
        redirectUri: REDIRECT_URI,
        code
      });

      const longToken = await exchangeLongLivedToken({
        appId: FACEBOOK_APP_ID,
        appSecret: FACEBOOK_APP_SECRET,
        shortLivedToken: shortToken.access_token
      });

      const assets = await fetchWhatsAppAssets(longToken.access_token, {
        waba_id: typeof wabaIdHint === "string" ? wabaIdHint : null,
        phone_number_id:
          typeof phoneNumberIdHint === "string" ? phoneNumberIdHint : null,
        business_id: typeof businessIdHint === "string" ? businessIdHint : null
      });

      const payload = {
        access_token: longToken.access_token,
        expires_in: longToken.expires_in || null,
        business_id: assets.business_id,
        waba_id: assets.waba_id,
        phone_number_id: assets.phone_number_id
      };

      const notifyResult = await notifyWhitelabel({
        returnOrigin,
        connectPath: WHITELABEL_CONNECT_PATH,
        payload,
        stateSecret: STATE_SECRET
      });

      if (!notifyResult.ok) {
        return res.status(502).send(
          renderDonePage({
            origin: returnOrigin,
            ok: false,
            data: {
              reason: "whitelabel_notify_failed",
              status: notifyResult.status
            },
            ...donePageOptions
          })
        );
      }

      return res.send(
        renderDonePage({
          origin: returnOrigin,
          ok: true,
          data: { reason: "connected" },
          ...donePageOptions
        })
      );
    } catch (err) {
      return res.status(500).send(
        renderDonePage({
          origin: returnOrigin,
          ok: false,
          data: {
            reason: "internal_error",
            error: err instanceof Error ? err.message : "Erro desconhecido"
          },
          ...donePageOptions
        })
      );
    }
  });

  const publicDir = path.join(__dirname, "public");

  app.get("/", (_, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/politica-de-privacidade", (_, res) => {
    res.sendFile(path.join(publicDir, "politica-de-privacidade", "index.html"));
  });

  app.get("/termos-de-uso", (_, res) => {
    res.sendFile(path.join(publicDir, "termos-de-uso", "index.html"));
  });

  app.use(express.static(publicDir));

  return app;
}

module.exports = createApp;
