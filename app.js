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
  buildMetaOnboardUrl
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
      META_CONFIG_ID,
      META_ONBOARD_EXTRAS,
      STATE_TTL_SECONDS,
      ALLOWED_RETURN_ORIGINS
    } = getConfig();

    const returnOrigin = req.query.return_origin;
    if (
      typeof returnOrigin !== "string" ||
      !isAllowedOrigin(returnOrigin, ALLOWED_RETURN_ORIGINS)
    ) {
      return res.status(400).json({
        error:
          "return_origin invalido. Configure na allowlist ALLOWED_RETURN_ORIGINS."
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const returnMode =
      req.query.return_mode === "redirect" ? "redirect" : "post_message";
    const normalizedOrigin = normalizeOrigin(returnOrigin);
    const state = signState(
      {
        return_origin: normalizedOrigin,
        return_mode: returnMode,
        nonce: crypto.randomBytes(16).toString("hex"),
        iat: now,
        exp: now + STATE_TTL_SECONDS
      },
      STATE_SECRET
    );

    const onboardUrl = buildMetaOnboardUrl({
      appId: FACEBOOK_APP_ID,
      configId: META_CONFIG_ID,
      redirectUri: REDIRECT_URI,
      state,
      extras: META_ONBOARD_EXTRAS
    });

    return res.redirect(onboardUrl);
  });

  app.get("/oauth/meta/callback", async (req, res) => {
    const {
      FACEBOOK_APP_ID,
      FACEBOOK_APP_SECRET,
      REDIRECT_URI,
      STATE_SECRET,
      ALLOWED_RETURN_ORIGINS
    } = getConfig();

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
        redirectUrl.searchParams.set(
          "expires_in",
          String(tokenData.expires_in || "")
        );
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
