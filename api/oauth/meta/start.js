const crypto = require("crypto");
const {
  getConfig,
  signState,
  isAllowedOrigin,
  normalizeOrigin,
  buildMetaOnboardUrl
} = require("../../../lib/metaBroker");

module.exports = function handler(req, res) {
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
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        error:
          "return_origin invalido. Configure na allowlist ALLOWED_RETURN_ORIGINS."
      })
    );
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

  res.statusCode = 302;
  res.setHeader("Location", onboardUrl);
  res.end();
};
