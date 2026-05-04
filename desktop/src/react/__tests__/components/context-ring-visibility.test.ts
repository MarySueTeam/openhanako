import { describe, expect, it } from 'vitest';

import {
  getContextRingTokenThreshold,
  shouldShowContextRing,
} from '../../components/input/context-ring-visibility';

describe('context ring visibility', () => {
  it('uses 30% of a 200k window, so 60k tokens is visible', () => {
    expect(getContextRingTokenThreshold(200_000)).toBe(60_000);
    expect(shouldShowContextRing({ tokens: 59_999, contextWindow: 200_000, compacting: false })).toBe(false);
    expect(shouldShowContextRing({ tokens: 60_000, contextWindow: 200_000, compacting: false })).toBe(true);
  });

  it('caps the display threshold at 100k tokens for large windows', () => {
    expect(getContextRingTokenThreshold(1_000_000)).toBe(100_000);
    expect(shouldShowContextRing({ tokens: 99_999, contextWindow: 1_000_000, compacting: false })).toBe(false);
    expect(shouldShowContextRing({ tokens: 100_000, contextWindow: 1_000_000, compacting: false })).toBe(true);
  });

  it('keeps the ring visible during compaction even when usage is below threshold', () => {
    expect(shouldShowContextRing({ tokens: 1_000, contextWindow: 200_000, compacting: true })).toBe(true);
  });
});
