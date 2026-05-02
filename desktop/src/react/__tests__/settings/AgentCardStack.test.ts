/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { calculateAgentCardGeometry } from '../../settings/tabs/agent/AgentCardStack';

describe('AgentCardStack geometry', () => {
  it('centers a one-agent stack when it expands', () => {
    const geometry = calculateAgentCardGeometry(2);

    expect(geometry.spreadWidth).toBe(260);
    expect(geometry.positions).toEqual([63, 135]);
    expect(geometry.positions[0] + geometry.groupWidth / 2).toBe(130);
  });

  it('centers a two-agent stack when it expands', () => {
    const geometry = calculateAgentCardGeometry(3);

    expect(geometry.spreadWidth).toBe(260);
    expect(geometry.positions).toEqual([27, 99, 171]);
    expect(geometry.positions[0] + geometry.groupWidth / 2).toBe(130);
  });

  it('uses the natural group width once the expanded stack is wider than compact width', () => {
    const geometry = calculateAgentCardGeometry(5);

    expect(geometry.spreadWidth).toBe(386);
    expect(geometry.positions).toEqual([18, 90, 162, 234, 306]);
  });

  it('adds edge bleed before the expanded cards touch the scroll boundary', () => {
    const geometry = calculateAgentCardGeometry(4);

    expect(geometry.spreadWidth).toBe(314);
    expect(geometry.positions).toEqual([18, 90, 162, 234]);
  });
});
