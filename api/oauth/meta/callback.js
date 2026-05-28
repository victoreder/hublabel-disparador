const {
  getConfig,
  verifyState,
  isAllowedOrigin,
  renderDonePage
} = require("../../../lib/metaBroker");

module.exports = async function handler(req, res) {
  const {
    FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET,
    REDIRECT_URI,
    STATE_SECRET,
    ALLOWED_RETURN_ORIGINS
  } = getConfig();

  const { code, state, error, error_description: errorDescription } = req.query;

  if (typeof state !== "string") {
    res.statusCode = 400;
    return res.end(
      renderDonePage({
        origin: "",
        ok: false,
        data: { reason: "missing_state" }
      })
    );
  }

  const parsedState = verifyState(state, STATE_SECRET);
  if (!parsedState || !isAllowedOrigin(parsedState.return_origin, ALLOWED_RETURN_ORIGINS)) {
    res.statusCode = 400;
    return res.end(
      renderDonePage({
        origin: "",
        ok: false,
        data: { reason: "invalid_or_expired_state" }
      })
    );
  }

  const returnOrigin = parsedState.return_origin;

  if (typeof error === "string") {
    res.statusCode = 400;
    return res.end(
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
    res.statusCode = 400;
    return res.end(
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
      res.statusCode = 400;
      return res.end(
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

      res.statusCode = 302;
      res.setHeader("Location", redirectUrl.toString());
      return res.end();
    }

    res.statusCode = 200;
    return res.end(
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
    res.statusCode = 500;
    return res.end(
      renderDonePage({
        origin: returnOrigin,
        ok: false,
        data: { reason: "internal_error" }
      })
    );
  }
};

