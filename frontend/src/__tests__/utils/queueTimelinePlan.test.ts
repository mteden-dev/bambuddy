/**
 * The queue timeline's plan and holds (fork): what a hold means, when a plan
 * laid out on old data is out of date, laying the user's moves again onto the
 * current forecast, the default zoom, and the toast after applying.
 */
import { describe, expect, it } from 'vitest';

import {
  ZOOM_HOURS,
  planAppliedToast,
  planIsStale,
  rebasePlan,
  reservationState,
  zoomForTrackWidth,
} from '../../utils/queueTimelinePlan';

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key);

describe('zoomForTrackWidth', () => {
  it('gives an hour at least 50 px, and at most 24 hours', () => {
    expect(ZOOM_HOURS[zoomForTrackWidth(1400)]).toBe(24);
    expect(ZOOM_HOURS[zoomForTrackWidth(1199)]).toBe(12);
    // An iPad across: about 33 px an hour at 24 hours, so 12.
    expect(ZOOM_HOURS[zoomForTrackWidth(800)]).toBe(12);
    expect(ZOOM_HOURS[zoomForTrackWidth(500)]).toBe(8);
    expect(ZOOM_HOURS[zoomForTrackWidth(100)]).toBe(4);
  });
});

describe('reservationState', () => {
  it('takes a hold without the new fields for a firm hold the user made', () => {
    expect(reservationState({ printer_id: 1, active: true }, 2)).toEqual({ kind: 'firm', byPlanner: false });
  });

  it('tells the planner\'s soft hold that holds from one that gave way', () => {
    const soft = { printer_id: 1, active: true, source: 'plan' as const, soft: true };
    expect(reservationState({ ...soft, placed: true }, 1)).toEqual({ kind: 'soft', byPlanner: true });
    expect(reservationState({ ...soft, placed: false }, 2)).toEqual({ kind: 'gaveWay', byPlanner: true });
    // Drawn on another printer than it is held for: it gave way, whatever `placed` says.
    expect(reservationState(soft, 2).kind).toBe('gaveWay');
    expect(reservationState({ ...soft, placed: false }, null).kind).toBe('gaveWay');
  });

  it('keeps a planner\'s hold that does not give way firm', () => {
    expect(reservationState({ printer_id: 1, active: true, source: 'plan', soft: false }, 2))
      .toEqual({ kind: 'firm', byPlanner: true });
  });
});

describe('planIsStale', () => {
  const base = { 1: [10, 11], 2: [20, 21] };

  it('is fresh while only the moved jobs differ', () => {
    expect(planIsStale(base, { 1: [10, 11], 2: [20, 21] }, [])).toBe(false);
    // Job 21 was moved in the plan; where the forecast now has it does not matter.
    expect(planIsStale(base, { 1: [10, 11, 21], 2: [20] }, [21])).toBe(false);
  });

  it('is stale when a job the user did not move changed lane or order', () => {
    expect(planIsStale(base, { 1: [10], 2: [20, 21, 11] }, [])).toBe(true);
    expect(planIsStale(base, { 1: [11, 10], 2: [20, 21] }, [])).toBe(true);
  });

  it('is stale when a job arrived or left, the moved ones too', () => {
    expect(planIsStale(base, { 1: [10, 11, 12], 2: [20, 21] }, [])).toBe(true);
    expect(planIsStale(base, { 1: [10], 2: [20, 21] }, [])).toBe(true);
    expect(planIsStale(base, { 1: [10, 11], 2: [20] }, [21])).toBe(true);
  });
});

describe('rebasePlan', () => {
  it('lays the moves onto the current lanes after the job that was before them', () => {
    // The plan put 21 after 10 on printer 1; meanwhile 12 arrived after 10.
    const draft = { lanes: { 1: [10, 21, 11], 2: [20] }, moved: [21] };
    const current = { 1: [10, 12, 11], 2: [20, 21] };

    const next = rebasePlan(draft, current, () => true);

    expect(next).toEqual({ lanes: { 1: [10, 21, 12, 11], 2: [20] }, moved: [21], base: current });
  });

  it('drops moves that no longer apply, and the plan with none left', () => {
    const draft = { lanes: { 1: [21, 10], 2: [20, 22] }, moved: [21, 22] };
    const current = { 1: [10], 2: [20, 22] };

    const next = rebasePlan(draft, current, (id) => id !== 21);
    expect(next?.moved).toEqual([22]);
    expect(next?.lanes[1]).toEqual([10]);

    expect(rebasePlan(draft, current, () => false)).toBeNull();
  });
});

describe('planAppliedToast', () => {
  const names: Record<number, string> = { 4: 'Lid', 7: 'Tray' };

  it('names the jobs held for their printer, or says there are none', () => {
    expect(planAppliedToast({ reserved: [4, 7], moved_elsewhere: [] }, (id) => names[id], t))
      .toEqual({ text: 'queue.timeline.plan.applied {"names":"Lid, Tray"}', type: 'success' });
    expect(planAppliedToast({ reserved: [], moved_elsewhere: [] }, (id) => names[id], t))
      .toEqual({ text: 'queue.timeline.plan.appliedNone', type: 'success' });
  });

  it('warns about jobs forecast elsewhere anyway', () => {
    const toast = planAppliedToast({ reserved: [4], moved_elsewhere: [7] }, (id) => names[id], t);
    expect(toast.type).toBe('warning');
    expect(toast.text).toBe('queue.timeline.plan.applied {"names":"Lid"} queue.timeline.plan.elsewhere {"count":1}');
  });
});
