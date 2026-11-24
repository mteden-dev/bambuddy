/**
 * Marks on given dates when nobody is at the farm, or someone is (fork,
 * services/staffed_hours.py). They are wall-clock "YYYY-MM-DDTHH:MM" in the
 * farm's time zone; here they are worked with as minutes on a clock without a
 * zone (Date.UTC of the wall-clock fields), so a day is always 1440 minutes
 * and nothing depends on the browser's zone.
 */
import type { QueueStaffedHours, QueueStaffedMark, QueueStaffedMarkKind } from '../api/client';

export const DAY_MIN = 1440;

/** How a stretch marked "nobody there" is drawn: red stripes. */
export const AWAY_STRIPES =
  'repeating-linear-gradient(-45deg, rgba(248,113,113,0.75) 0 3px, rgba(220,38,38,0.55) 3px 6px)';

export interface Span {
  from: number;
  to: number;
}

export interface MarkSpan extends Span {
  kind: QueueStaffedMarkKind;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DDTHH:MM" as minutes on the zone-less clock. */
export function stampToMin(stamp: string): number {
  const [date, time = '00:00'] = stamp.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 60_000;
}

export function minToStamp(min: number): string {
  const d = new Date(min * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The wall clock in `zone` at `now`, as minutes on the zone-less clock. */
export function zoneNowMin(zone: string, now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) / 60_000;
  } catch {
    return Math.floor(now.getTime() / 60_000) - now.getTimezoneOffset();
  }
}

/** The start of the day `min` falls in. */
export function dayStart(min: number): number {
  return Math.floor(min / DAY_MIN) * DAY_MIN;
}

/** The weekday of `min`, Monday 0. */
export function weekdayOf(min: number): number {
  return (new Date(min * 60_000).getUTCDay() + 6) % 7;
}

function hhmm(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/** The weekly hours' staffed stretches within the day starting at `day` (one may run in from the day before). */
export function weeklyStaffed(days: QueueStaffedHours['days'], day: number): Span[] {
  const spans: Span[] = [];
  for (const k of [day - DAY_MIN, day]) {
    const hours = days[weekdayOf(k)];
    if (!hours) continue;
    const opens = k + hhmm(hours.start);
    let closes = k + hhmm(hours.end);
    if (closes <= opens) closes += DAY_MIN;
    const from = Math.max(opens, day);
    const to = Math.min(closes, day + DAY_MIN);
    if (to > from) spans.push({ from, to });
  }
  return spans;
}

export function marksToSpans(marks: QueueStaffedMark[]): MarkSpan[] {
  return marks.map((m) => ({ from: stampToMin(m.start), to: stampToMin(m.end), kind: m.kind }));
}

function spansToMarks(spans: MarkSpan[]): QueueStaffedMark[] {
  return spans.map((s) => ({ start: minToStamp(s.from), end: minToStamp(s.to), kind: s.kind }));
}

/** The parts of `spans` within `from`..`to`. */
export function clipSpans<T extends Span>(spans: T[], from: number, to: number): T[] {
  return spans
    .filter((s) => s.to > from && s.from < to)
    .map((s) => ({ ...s, from: Math.max(s.from, from), to: Math.min(s.to, to) }));
}

/**
 * `marks` with `from`..`to` marked `kind`, or cleared with null. Whatever
 * was marked there gives way; stretches of a kind that touch become one.
 */
export function paintMarks(
  marks: QueueStaffedMark[],
  from: number,
  to: number,
  kind: QueueStaffedMarkKind | null,
): QueueStaffedMark[] {
  const spans: MarkSpan[] = [];
  for (const s of marksToSpans(marks)) {
    if (s.to <= from || s.from >= to) {
      spans.push(s);
      continue;
    }
    if (s.from < from) spans.push({ ...s, to: from });
    if (s.to > to) spans.push({ ...s, from: to });
  }
  if (kind && to > from) spans.push({ from, to, kind });
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: MarkSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && last.kind === s.kind && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return spansToMarks(merged);
}

/** `marks` with the one at `index` changed to `next`, which wins over the others where they overlap. */
export function editMark(marks: QueueStaffedMark[], index: number, next: QueueStaffedMark): QueueStaffedMark[] {
  return paintMarks(
    marks.filter((_, i) => i !== index),
    stampToMin(next.start),
    stampToMin(next.end),
    next.kind,
  );
}
