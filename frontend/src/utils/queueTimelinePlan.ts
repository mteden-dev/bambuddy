/**
 * Fork: the queue timeline's plan and holds, apart from the components so
 * they can be tested on their own.
 */
import type { QueueForecastReservation } from '../api/client';

/** Each printer's queued jobs, in order. */
export type PlanLanes = Record<number, number[]>;

// Zoom: how many hours the window shows, from close up to three days.
export const ZOOM_HOURS = [4, 8, 12, 24, 48, 72];
// Fork: until someone zooms, the window is the most hours (up to 24) that
// still give an hour this many pixels of the track, so a print stays readable.
const MIN_HOUR_PX = 50;
export function zoomForTrackWidth(width: number): number {
  const fits = ZOOM_HOURS.filter((h) => h <= 24 && width / h >= MIN_HOUR_PX);
  return ZOOM_HOURS.indexOf(fits.length > 0 ? fits[fits.length - 1] : ZOOM_HOURS[0]);
}

/**
 * What a hold of an "Any" job means (fork): `firm`, it waits for its printer
 * (made on the timeline, or a planner's hold that does not give way); `soft`,
 * the product planner prefers that printer and the forecast keeps it there;
 * `gaveWay`, the planner's printer cannot take it in time, so it is forecast
 * on another. `printerId` is the lane the job is drawn on, if any.
 */
export type QueueHoldKind = 'firm' | 'soft' | 'gaveWay';
export function reservationState(
  reservation: QueueForecastReservation,
  printerId: number | null,
): { kind: QueueHoldKind; byPlanner: boolean } {
  // Fields an older server leaves out: a user's firm hold, placed where it is held.
  const byPlanner = reservation.source === 'plan';
  if (!byPlanner || reservation.soft !== true) return { kind: 'firm', byPlanner };
  const placed = (reservation.placed ?? true) && (printerId == null || printerId === reservation.printer_id);
  return { kind: placed ? 'soft' : 'gaveWay', byPlanner };
}

/** The lanes as their jobs' order, without the given jobs, for comparing. */
function laneOrders(lanes: PlanLanes, without: Set<number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [printerId, ids] of Object.entries(lanes)) {
    const kept = ids.filter((id) => !without.has(id));
    if (kept.length > 0) out[printerId] = kept.join(',');
  }
  return out;
}

/** Fork: the queue changed under an open plan: a job the user did not move
 *  changed lane or order, or a job arrived or left. */
export function planIsStale(
  base: PlanLanes,
  current: PlanLanes,
  moved: number[],
): boolean {
  const movedSet = new Set(moved);
  const before = laneOrders(base, movedSet);
  const now = laneOrders(current, movedSet);
  const keys = new Set([...Object.keys(before), ...Object.keys(now)]);
  for (const key of keys) if (before[key] !== now[key]) return true;
  // A moved job that started or left.
  const present = new Set(Object.values(current).flat());
  return moved.some((id) => !present.has(id));
}

/** Fork: the user's moves laid again onto the current forecast, where they
 *  still can be: each moved job goes onto the lane it was put on, after the
 *  nearest job that was before it there. `canStay` drops a move that no
 *  longer applies (the job started, left, or was pinned elsewhere). */
export function rebasePlan(
  draft: { lanes: PlanLanes; moved: number[] },
  current: PlanLanes,
  canStay: (id: number, printerId: number) => boolean,
): { lanes: PlanLanes; moved: number[]; base: PlanLanes } | null {
  const movedSet = new Set(draft.moved);
  const lanes: PlanLanes = {};
  for (const [printerId, ids] of Object.entries(current)) {
    lanes[Number(printerId)] = ids.filter((id) => !movedSet.has(id));
  }
  const kept: number[] = [];
  for (const id of draft.moved) {
    const entry = Object.entries(draft.lanes).find(([, ids]) => ids.includes(id));
    if (!entry) continue;
    const printerId = Number(entry[0]);
    if (!canStay(id, printerId)) continue;
    const lane = (lanes[printerId] ??= []);
    const before = entry[1].slice(0, entry[1].indexOf(id));
    let index = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const at = lane.indexOf(before[i]);
      if (at !== -1) {
        index = at + 1;
        break;
      }
    }
    lane.splice(index, 0, id);
    kept.push(id);
  }
  return kept.length > 0 ? { lanes, moved: kept, base: current } : null;
}


/** Fork: the toast after a plan is applied: the jobs now held for their
 *  printer by name (or that there are none), and any forecast elsewhere. */
export function planAppliedToast(
  result: { reserved: number[]; moved_elsewhere: number[] },
  nameOf: (id: number) => string,
  t: (key: string, options?: Record<string, unknown>) => string,
): { text: string; type: 'success' | 'warning' } {
  const names = result.reserved.map(nameOf);
  const applied = names.length > 0
    ? t('queue.timeline.plan.applied', { names: names.join(', ') })
    : t('queue.timeline.plan.appliedNone');
  return result.moved_elsewhere.length > 0
    ? { text: `${applied} ${t('queue.timeline.plan.elsewhere', { count: result.moved_elsewhere.length })}`, type: 'warning' }
    : { text: applied, type: 'success' };
}
