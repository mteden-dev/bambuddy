import { describe, expect, it } from 'vitest';
import { fitBarHeight, LANE_BAR_HEIGHT_PX, MAX_LANE_BAR_HEIGHT_PX } from '../../utils/timelineLayout';

describe('fitBarHeight (fork)', () => {
  it('shares the room below the lanes between the printers', () => {
    // 900 - 300 - 40 = 560 for 5 printers: 112 a lane, 96 a bar.
    expect(fitBarHeight(300, 900, 5, 40)).toBe(96);
  });

  it('never goes below the old bar nor above the most', () => {
    expect(fitBarHeight(700, 800, 6, 40)).toBe(LANE_BAR_HEIGHT_PX);
    expect(fitBarHeight(100, 2000, 2, 40)).toBe(MAX_LANE_BAR_HEIGHT_PX);
    expect(fitBarHeight(100, 900, 0, 40)).toBe(LANE_BAR_HEIGHT_PX);
  });
});
