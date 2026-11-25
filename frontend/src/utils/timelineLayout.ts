/**
 * Fork: how tall the queue timeline's bars are. The lanes fill the room the
 * screen has below them, a share per printer, between these bounds.
 */

// The least a bar is tall (the timeline as it always was), and the most.
export const LANE_BAR_HEIGHT_PX = 40;
export const MAX_LANE_BAR_HEIGHT_PX = 160;
// Above and below the bar in its lane.
export const LANE_PADDING_PX = 16;

/** The bar height that fills the room under the lanes' top: one share per printer, within the bounds. */
export function fitBarHeight(lanesTop: number, viewportHeight: number, lanes: number, reserve: number): number {
  if (lanes <= 0) return LANE_BAR_HEIGHT_PX;
  const share = Math.floor((viewportHeight - lanesTop - reserve) / lanes) - LANE_PADDING_PX;
  return Math.max(LANE_BAR_HEIGHT_PX, Math.min(MAX_LANE_BAR_HEIGHT_PX, share));
}
