export const CONTEXT_RING_PERCENT_THRESHOLD = 0.3;
export const CONTEXT_RING_TOKEN_THRESHOLD_CAP = 100_000;

export function getContextRingTokenThreshold(contextWindow: number | null | undefined): number | null {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.min(
    Math.floor(contextWindow * CONTEXT_RING_PERCENT_THRESHOLD),
    CONTEXT_RING_TOKEN_THRESHOLD_CAP,
  );
}

export function shouldShowContextRing({
  tokens,
  contextWindow,
  compacting,
}: {
  tokens: number | null | undefined;
  contextWindow: number | null | undefined;
  compacting: boolean;
}): boolean {
  if (compacting) return true;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return false;
  const threshold = getContextRingTokenThreshold(contextWindow);
  return threshold !== null && tokens >= threshold;
}
