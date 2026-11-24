import { describe, expect, it } from 'vitest';

import {
  DAY_MIN,
  dayStart,
  editMark,
  minToStamp,
  paintMarks,
  stampToMin,
  weekdayOf,
  weeklyStaffed,
  zoneNowMin,
} from '../../utils/staffedMarks';
import type { QueueStaffedMark } from '../../api/client';

const at = (stamp: string) => stampToMin(`2026-11-${stamp}`);
const away = (start: string, end: string): QueueStaffedMark => ({
  start: `2026-11-${start}`,
  end: `2026-11-${end}`,
  kind: 'away',
});
const here = (start: string, end: string): QueueStaffedMark => ({ ...away(start, end), kind: 'here' });

describe('staffed marks', () => {
  it('reads and writes wall-clock stamps, a day being 1440 minutes', () => {
    expect(minToStamp(at('24T08:30'))).toBe('2026-11-24T08:30');
    expect(at('25T00:00') - at('24T00:00')).toBe(DAY_MIN);
    expect(dayStart(at('24T17:45'))).toBe(at('24T00:00'));
    // Monday 23 November 2026.
    expect(weekdayOf(at('23T12:00'))).toBe(0);
    expect(weekdayOf(at('29T12:00'))).toBe(6);
  });

  it('tells the wall clock in the farm zone, whatever the browser is in', () => {
    const now = new Date('2026-11-24T11:00:00Z');
    expect(minToStamp(zoneNowMin('Europe/Warsaw', now))).toBe('2026-11-24T12:00');
    expect(minToStamp(zoneNowMin('America/New_York', now))).toBe('2026-11-24T06:00');
  });

  it('paints a stretch, which gives way to nothing and merges with its kind', () => {
    let marks = paintMarks([], at('24T00:00'), at('24T08:00'), 'away');
    expect(marks).toEqual([away('24T00:00', '24T08:00')]);
    // Crossing midnight is one stretch.
    marks = paintMarks(marks, at('25T23:00'), at('26T06:00'), 'away');
    marks = paintMarks(marks, at('24T08:00'), at('24T09:00'), 'away');
    expect(marks).toEqual([away('24T00:00', '24T09:00'), away('25T23:00', '26T06:00')]);
    // Someone is there for a while after all: the absence is split around it.
    marks = paintMarks(marks, at('24T03:00'), at('24T04:00'), 'here');
    expect(marks).toEqual([
      away('24T00:00', '24T03:00'),
      here('24T03:00', '24T04:00'),
      away('24T04:00', '24T09:00'),
      away('25T23:00', '26T06:00'),
    ]);
  });

  it('clears a stretch', () => {
    const marks = [away('24T00:00', '24T08:00'), here('24T10:00', '24T12:00')];
    expect(paintMarks(marks, at('24T06:00'), at('24T11:00'), null)).toEqual([
      away('24T00:00', '24T06:00'),
      here('24T11:00', '24T12:00'),
    ]);
  });

  it('an edited mark wins over the ones it now overlaps', () => {
    const marks = [away('24T00:00', '24T08:00'), here('24T10:00', '24T12:00')];
    expect(editMark(marks, 1, here('24T07:00', '24T12:00'))).toEqual([
      away('24T00:00', '24T07:00'),
      here('24T07:00', '24T12:00'),
    ]);
  });

  it('lays the weekly hours over a day, a late shift running in from the day before', () => {
    const days = Array.from({ length: 7 }, () => ({ start: '20:00', end: '02:00' }));
    expect(weeklyStaffed(days, at('24T00:00'))).toEqual([
      { from: at('24T00:00'), to: at('24T02:00') },
      { from: at('24T20:00'), to: at('25T00:00') },
    ]);
    const sundayOff = [...Array.from({ length: 6 }, () => ({ start: '07:00', end: '22:00' })), null];
    expect(weeklyStaffed(sundayOff, at('29T00:00'))).toEqual([]);
  });
});
