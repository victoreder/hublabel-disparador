const DEFAULT_MEDIA_SETTLE_MS = 1500;
const MAX_MEDIA_SETTLE_MS = 10_000;

export function resolveMediaSettleDelayMs(agentConfig = {}) {
  const configured = Number(agentConfig.mediaSettleDelayMs ?? DEFAULT_MEDIA_SETTLE_MS);
  if (!Number.isFinite(configured)) return DEFAULT_MEDIA_SETTLE_MS;
  return Math.min(MAX_MEDIA_SETTLE_MS, Math.max(0, Math.trunc(configured)));
}

export async function waitForMediaSettlement(kind, agentConfig = {}, sleep = null) {
  if (kind === 'text') return 0;

  const delayMs = resolveMediaSettleDelayMs(agentConfig);
  if (delayMs <= 0) return 0;

  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await wait(delayMs);
  return delayMs;
}
