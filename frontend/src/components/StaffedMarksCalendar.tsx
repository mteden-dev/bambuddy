import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Eraser, Pencil, Trash2, UserCheck, UserX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { QueueStaffedHours, QueueStaffedMark, QueueStaffedMarkKind } from '../api/client';
import { formatDurationFromHours } from '../utils/date';
import {
  AWAY_STRIPES,
  DAY_MIN,
  clipSpans,
  dayStart,
  editMark,
  marksToSpans,
  minToStamp,
  paintMarks,
  stampToMin,
  weeklyStaffed,
  zoneNowMin,
  type Span,
} from '../utils/staffedMarks';

// Two weeks: as far as the forecast looks ahead.
const DAYS = 14;
// Everything snaps to the nearest half hour; a tap marks an hour from there.
const SNAP = 30;
const TAP = 60;
const MAX_LENGTH = 31 * DAY_MIN;
// Further than this from where it went down, the pointer is dragging, not tapping.
const DRAG_PX = 5;
// This close to a mark's end, the pointer grabs the end to stretch or shorten it.
const EDGE_PX = { mouse: 6, touch: 10 };

type Brush = QueueStaffedMarkKind | 'erase';
// What the pointer has hold of in a mark: all of it, or one of its ends.
type Part = 'move' | 'start' | 'end';

const KIND_STYLE: Record<QueueStaffedMarkKind, { className: string; image?: string }> = {
  away: { className: '', image: AWAY_STRIPES },
  here: { className: 'bg-bambu-green/70' },
};

interface Drag {
  // Painting with the brush, or moving a mark (or one of its ends).
  mode: 'paint' | Part;
  // The mark moved; -1 when painting.
  index: number;
  anchor: number;
  current: number;
  // The row the pointer went down in, and the one it is over.
  anchorRow: number;
  row: number;
  x: number;
  y: number;
  moved: boolean;
}

interface Hover {
  at: number;
  row: number;
  index: number;
  part: Part | null;
}

const snap = (min: number) => Math.round(min / SNAP) * SNAP;

/** The stretch a drag (or a tap) paints. */
function paintSpan(drag: Drag, rows: number[]): Span {
  if (!drag.moved) {
    // An hour from the half hour tapped, kept in the row.
    const from = Math.min(snap(drag.anchor), rows[drag.anchorRow] + DAY_MIN - TAP);
    return { from, to: from + TAP };
  }
  const from = snap(Math.min(drag.anchor, drag.current));
  const to = snap(Math.max(drag.anchor, drag.current));
  return { from, to: Math.max(to, from + SNAP) };
}

/** Where a mark moved or stretched by a drag goes. */
function movedSpan(drag: Drag, span: Span): Span {
  if (drag.mode === 'move') {
    const delta = snap(drag.current - drag.anchor);
    return { from: span.from + delta, to: span.to + delta };
  }
  if (drag.mode === 'start') {
    const from = Math.max(span.to - MAX_LENGTH, Math.min(snap(drag.current), span.to - SNAP));
    return { from, to: span.to };
  }
  const to = Math.min(span.from + MAX_LENGTH, Math.max(snap(drag.current), span.from + SNAP));
  return { from: span.from, to };
}

const plausible = (value: string) => {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value);
  return match != null && Number(match[1]) >= 2000 && Number(match[1]) <= 2100;
};

/**
 * Marks on given dates (fork, services/staffed_hours.py): the coming two
 * weeks, a row a day, in the farm's time zone. Dragging over the rows marks
 * the hours with the chosen brush, across midnight into the next row too;
 * a mark grabbed is moved, by an end stretched or shortened. A popup over
 * the hours says where the pointer is, to the half hour. The list below
 * sets the marks to the minute.
 */
export function StaffedMarksCalendar({
  marks,
  onChange,
  timezone,
  days,
  weeklyEnabled,
  readOnly,
  t,
}: {
  marks: QueueStaffedMark[];
  onChange: (marks: QueueStaffedMark[]) => void;
  /** The farm's zone: the rows are its days, the marks its wall-clock times. */
  timezone: string;
  /** The weekly hours, shaded behind the marks when used. */
  days: QueueStaffedHours['days'];
  weeklyEnabled: boolean;
  readOnly: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { i18n } = useTranslation();
  const [nowMin, setNowMin] = useState(() => zoneNowMin(timezone));
  useEffect(() => {
    setNowMin(zoneNowMin(timezone));
    const id = window.setInterval(() => setNowMin(zoneNowMin(timezone)), 60_000);
    return () => window.clearInterval(id);
  }, [timezone]);
  const today = dayStart(nowMin);
  const rows = useMemo(() => Array.from({ length: DAYS }, (_, i) => today + i * DAY_MIN), [today]);
  const spans = useMemo(() => marksToSpans(marks), [marks]);
  const [brush, setBrush] = useState<Brush>('away');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // The mark tapped: its row in the list is brought into view.
  const [picked, setPicked] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Fork: a finger paints only in edit mode; otherwise a swipe over the grid
  // scrolls the sheet (pan-y) and a tap picks a mark. A mouse always paints.
  const [editing, setEditing] = useState(false);
  const tapStart = useRef<{ x: number; y: number } | null>(null);

  const dayLabel = (min: number, options: Intl.DateTimeFormatOptions) =>
    new Date(min * 60_000).toLocaleDateString(i18n.language, { timeZone: 'UTC', ...options });
  const timeLabel = (min: number) =>
    new Date(min * 60_000).toLocaleTimeString(i18n.language, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const rangeLabel = ({ from, to }: Span) => {
    const day = dayStart(from);
    const start = `${dayLabel(from, { weekday: 'short', day: 'numeric', month: 'numeric' })} ${timeLabel(from)}`;
    if (to <= day + DAY_MIN) return `${start} – ${to === day + DAY_MIN ? '24:00' : timeLabel(to)}`;
    return `${start} → ${dayLabel(to, { weekday: 'short', day: 'numeric', month: 'numeric' })} ${timeLabel(to)}`;
  };
  const lengthLabel = ({ from, to }: Span) => formatDurationFromHours((to - from) / 60);
  const change = (next: QueueStaffedMark[]) => {
    setPicked(null);
    onChange(next);
  };

  /** The row and the minute under the pointer. */
  const pointAt = (clientX: number, clientY: number): { at: number; row: number; width: number } => {
    const rect = gridRef.current!.getBoundingClientRect();
    const row = Math.min(DAYS - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * DAYS)));
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { at: rows[row] + fraction * DAY_MIN, row, width: rect.width };
  };
  /** The mark under the pointer and the part of it held: an end close by, or else the whole of it. */
  const grab = (at: number, row: number, edge: number): { index: number; part: Part } | null => {
    const rowStart = rows[row];
    let body: { index: number; part: Part } | null = null;
    for (let index = 0; index < spans.length; index++) {
      const s = spans[index];
      // A mark too short for its ends to tell apart from it is only moved.
      if (s.to - s.from >= 3 * edge) {
        if (Math.abs(at - s.from) <= edge && s.from >= rowStart && s.from < rowStart + DAY_MIN) return { index, part: 'start' };
        if (Math.abs(at - s.to) <= edge && s.to > rowStart && s.to <= rowStart + DAY_MIN) return { index, part: 'end' };
      }
      if (body == null && s.from <= at && at < s.to) body = { index, part: 'move' };
    }
    return body;
  };
  const edgeMinutes = (pointerType: string, width: number) =>
    ((pointerType === 'mouse' ? EDGE_PX.mouse : EDGE_PX.touch) / Math.max(width, 1)) * DAY_MIN;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType !== 'mouse' && !editing) {
      // Not painting: the browser scrolls; a tap that stays put picks a mark.
      tapStart.current = { x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { at, row, width } = pointAt(e.clientX, e.clientY);
    // The eraser always paints; any other brush takes hold of a mark it lands on.
    const held = brush === 'erase' ? null : grab(at, row, edgeMinutes(e.pointerType, width));
    setHover(null);
    setDrag({
      mode: held?.part ?? 'paint',
      index: held?.index ?? -1,
      anchor: at,
      current: at,
      anchorRow: row,
      row,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tapStart.current && Math.hypot(e.clientX - tapStart.current.x, e.clientY - tapStart.current.y) > DRAG_PX) {
      tapStart.current = null;
    }
    const { at, row, width } = pointAt(e.clientX, e.clientY);
    if (!drag) {
      if (readOnly || e.pointerType === 'touch') return;
      const held = brush === 'erase' ? null : grab(at, row, edgeMinutes(e.pointerType, width));
      setHover({ at, row, index: held?.index ?? -1, part: held?.part ?? null });
      return;
    }
    const moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_PX;
    setDrag({ ...drag, current: at, row, moved });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tapStart.current) {
      tapStart.current = null;
      const { at, row, width } = pointAt(e.clientX, e.clientY);
      const held = grab(at, row, edgeMinutes(e.pointerType, width));
      if (held) setPicked(held.index);
      return;
    }
    if (!drag) return;
    setDrag(null);
    if (drag.mode === 'paint') {
      const { from, to } = paintSpan(drag, rows);
      change(paintMarks(marks, from, to, brush === 'erase' ? null : brush));
    } else if (drag.moved) {
      const { from, to } = movedSpan(drag, spans[drag.index]);
      change(editMark(marks, drag.index, { ...marks[drag.index], start: minToStamp(from), end: minToStamp(to) }));
    } else {
      // A tap on a mark: its row in the list, to set it to the minute.
      setPicked(drag.index);
    }
  };

  // While a mark is moved, the marks as they will be once it is let go.
  const moving = drag && drag.mode !== 'paint' ? movedSpan(drag, spans[drag.index]) : null;
  const shown = useMemo(
    () =>
      moving && drag
        ? marksToSpans(editMark(marks, drag.index, { ...marks[drag.index], start: minToStamp(moving.from), end: minToStamp(moving.to) }))
        : spans,
    // moving is worked out from drag and spans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag, marks, spans],
  );
  const preview = drag?.mode === 'paint' ? paintSpan(drag, rows) : null;
  // What the status line reads: the stretch painted, or where the mark goes.
  const status = preview ?? moving;
  const statusKind: Brush = moving && drag ? spans[drag.index].kind : brush;

  // The popup over the hours: the half hour under the pointer, or the end being moved.
  const tip = (() => {
    if (drag) {
      if (drag.mode === 'paint') return { time: drag.moved ? snap(drag.current) : preview!.from, row: drag.row };
      return { time: drag.mode === 'end' ? moving!.to : moving!.from, row: drag.row };
    }
    if (!hover) return null;
    const s = spans[hover.index];
    const time = hover.part === 'start' ? s.from : hover.part === 'end' ? s.to : snap(hover.at);
    return { time, row: hover.row };
  })();
  const tipAt = tip
    ? tip.time === rows[tip.row] + DAY_MIN
      ? { pct: 100, label: '24:00' }
      : { pct: ((tip.time - dayStart(tip.time)) / DAY_MIN) * 100, label: timeLabel(tip.time) }
    : null;
  const cursor = readOnly
    ? ''
    : drag
      ? drag.mode === 'move'
        ? 'cursor-grabbing'
        : drag.mode === 'paint'
          ? 'cursor-crosshair'
          : 'cursor-ew-resize'
      : hover?.part === 'move'
        ? 'cursor-grab'
        : hover?.part
          ? 'cursor-ew-resize'
          : 'cursor-crosshair';

  const upcoming = marks
    .map((mark, index) => ({ mark, index }))
    .filter(({ mark }) => stampToMin(mark.end) > nowMin);
  const at = (span: Span, row: number) => ({
    left: `${((span.from - row) / DAY_MIN) * 100}%`,
    width: `${((span.to - span.from) / DAY_MIN) * 100}%`,
  });
  const brushes: Array<{ key: Brush; icon: typeof UserX; label: string; tone: string }> = [
    { key: 'away', icon: UserX, label: t('queue.timeline.staffed.brushAway'), tone: 'text-red-300' },
    { key: 'here', icon: UserCheck, label: t('queue.timeline.staffed.brushHere'), tone: 'text-bambu-green' },
    { key: 'erase', icon: Eraser, label: t('queue.timeline.staffed.brushErase'), tone: 'text-bambu-gray' },
  ];

  return (
    <div className="space-y-3" data-testid="staffed-calendar">
      <p className="text-xs text-bambu-gray">{t('queue.timeline.staffed.calendarHelp')}</p>

      {!readOnly && (
        <div className="flex gap-1 p-1 rounded-lg bg-bambu-dark border border-bambu-dark-tertiary" role="radiogroup" aria-label={t('queue.timeline.staffed.brush')}>
          {brushes.map(({ key, icon: Icon, label, tone }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={brush === key}
              onClick={() => setBrush(key)}
              data-testid={`staffed-brush-${key}`}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors ${
                brush === key ? 'bg-bambu-dark-tertiary text-white shadow-sm' : 'text-bambu-gray hover:text-white'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${tone}`} />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      )}

      {!readOnly && <p className="text-[11px] text-bambu-gray">{t('queue.timeline.staffed.dragHint')}</p>}

      {/* A finger paints only once this is on, so a swipe scrolls the sheet (fork). */}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            data-testid="staffed-calendar-edit"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border any-pointer-coarse:min-h-[44px] ${
              editing ? 'border-bambu-green bg-bambu-green/20 text-bambu-green' : 'border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary'
            }`}
          >
            {editing ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
            {editing ? t('queue.timeline.staffed.editDone') : t('queue.timeline.staffed.editMarks')}
          </button>
          <span className="text-[11px] text-bambu-gray">
            {editing ? t('queue.timeline.staffed.editOnHint') : t('queue.timeline.staffed.editOffHint')}
          </span>
        </div>
      )}

      {/* What a drag covers, or where a moved mark goes. One line, so nothing shifts under the finger. */}
      <div className="h-4 text-[11px] flex items-center gap-1.5 min-w-0" aria-live="polite" data-testid="staffed-calendar-status">
        {status && (
          <>
            <span
              className={`inline-block w-3 h-3 shrink-0 rounded-sm ${statusKind === 'erase' ? 'bg-white/30' : KIND_STYLE[statusKind].className}`}
              style={statusKind === 'away' ? { backgroundImage: AWAY_STRIPES } : undefined}
            />
            <span className="text-white tabular-nums truncate">{rangeLabel(status)}</span>
            <span className="text-bambu-gray shrink-0">· {lengthLabel(status)}</span>
          </>
        )}
      </div>

      <div className="select-none">
        <div className="flex text-[10px] text-bambu-gray">
          <div className="w-[4.75rem] shrink-0" />
          <div className="relative flex-1 h-4">
            {[0, 6, 12, 18].map((h) => (
              <span key={h} className={`absolute ${h ? '-translate-x-1/2' : ''}`} style={{ left: `${(h / 24) * 100}%` }}>
                {h}
              </span>
            ))}
            <span className="absolute right-0">24</span>
            {/* Where the pointer is, to the half hour: over the hours, pointing down at the rows. */}
            {tipAt && (
              <>
                <span
                  className="pointer-events-none absolute bottom-[5px] z-10 -translate-x-1/2 whitespace-nowrap rounded bg-white px-1.5 py-0.5 text-[11px] font-medium leading-none text-gray-900 tabular-nums shadow"
                  style={{ left: `clamp(1.5rem, ${tipAt.pct}%, calc(100% - 1.5rem))` }}
                  data-testid="staffed-calendar-tip"
                >
                  {tipAt.label}
                </span>
                <span
                  className="pointer-events-none absolute bottom-0 z-10 -translate-x-1/2 h-0 w-0 border-x-[5px] border-t-[5px] border-x-transparent border-t-white"
                  style={{ left: `${tipAt.pct}%` }}
                />
              </>
            )}
          </div>
        </div>
        <div className="flex">
          <div className="w-[4.75rem] shrink-0">
            {rows.map((row, i) => (
              <div key={row} className={`h-7 flex items-baseline gap-1 text-[11px] leading-7 ${i === 0 ? 'text-bambu-green' : 'text-white'}`}>
                <span className="capitalize">
                  {i === 0 ? t('queue.timeline.staffed.today') : dayLabel(row, { weekday: 'short' })}
                </span>
                <span className="text-[10px] text-bambu-gray">{dayLabel(row, { day: 'numeric', month: 'numeric' })}</span>
              </div>
            ))}
          </div>
          <div
            ref={gridRef}
            className={`relative flex-1 ${cursor}`}
            style={{ touchAction: !readOnly && editing ? 'none' : 'pan-y' }}
            data-editing={editing ? 'true' : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              tapStart.current = null;
              setDrag(null);
            }}
            onPointerLeave={() => setHover(null)}
            data-testid="staffed-calendar-grid"
          >
            {tipAt && (
              <div
                className="pointer-events-none absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-white/60"
                style={{ left: `${tipAt.pct}%` }}
              />
            )}
            {rows.map((row, i) => (
              <div key={row} className="relative h-7" data-testid={`staffed-calendar-day-${i}`}>
                <div
                  className={`absolute inset-x-0 inset-y-1 rounded overflow-hidden ${
                    weeklyEnabled ? 'bg-black/40' : 'bg-bambu-dark-tertiary/70'
                  }`}
                >
                  {weeklyEnabled &&
                    weeklyStaffed(days, row).map((span) => (
                      <div key={span.from} className="absolute inset-y-0 bg-bambu-dark-tertiary/70" style={at(span, row)} />
                    ))}
                  {[3, 6, 9, 12, 15, 18, 21].map((h) => (
                    <div
                      key={h}
                      className={`absolute inset-y-0 w-px ${h % 6 === 0 ? 'bg-white/15' : 'bg-white/5'}`}
                      style={{ left: `${(h / 24) * 100}%` }}
                    />
                  ))}
                  {shown.map((whole) =>
                    clipSpans([whole], row, row + DAY_MIN).map((span) => {
                      const held = moving != null && whole.from === moving.from && whole.to === moving.to;
                      return (
                        <div
                          key={`${span.kind}-${span.from}`}
                          className={`absolute inset-y-0 ${KIND_STYLE[span.kind].className} ${
                            span.from === whole.from && !readOnly ? 'border-l-2 border-white/50' : ''
                          } ${span.to === whole.to && !readOnly ? 'border-r-2 border-white/50' : ''} ${
                            held ? 'ring-2 ring-inset ring-white/90' : ''
                          }`}
                          style={{ ...at(span, row), backgroundImage: KIND_STYLE[span.kind].image }}
                          data-testid="staffed-mark"
                          data-kind={span.kind}
                        />
                      );
                    }),
                  )}
                  {preview &&
                    clipSpans([preview], row, row + DAY_MIN).map((span) => (
                      <div
                        key="preview"
                        className={`absolute inset-y-0 ring-2 ring-inset ring-white/80 ${
                          brush === 'erase' ? 'bg-bambu-dark/80' : KIND_STYLE[brush].className
                        }`}
                        style={{ ...at(span, row), backgroundImage: brush === 'away' ? AWAY_STRIPES : undefined }}
                      />
                    ))}
                  {row === today && (
                    <>
                      <div className="absolute inset-y-0 left-0 bg-black/50" style={{ width: `${((nowMin - row) / DAY_MIN) * 100}%` }} />
                      <div className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${((nowMin - row) / DAY_MIN) * 100}%` }} />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 pl-[4.75rem] text-[10px] text-bambu-gray">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-[2px]" style={{ backgroundImage: AWAY_STRIPES }} />
            {t('queue.timeline.staffed.brushAway')}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-[2px] bg-bambu-green/70" />
            {t('queue.timeline.staffed.brushHere')}
          </span>
          {weeklyEnabled && (
            <>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-[2px] bg-bambu-dark-tertiary" />
                {t('queue.timeline.staffed.legendWeekOn')}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-[2px] bg-black/40 border border-bambu-dark-tertiary" />
                {t('queue.timeline.staffed.legendWeekOff')}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="space-y-2 pt-3 border-t border-bambu-dark-tertiary">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-white">{t('queue.timeline.staffed.marksTitle')}</span>
          {upcoming.length > 1 && !readOnly && (
            <button
              type="button"
              className="text-xs text-bambu-gray hover:text-red-300"
              onClick={() => change(marks.filter((m) => stampToMin(m.end) <= nowMin))}
            >
              {t('queue.timeline.staffed.clearAll')}
            </button>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="text-xs text-bambu-gray" data-testid="staffed-no-marks">
            {t('queue.timeline.staffed.noMarks')}
          </p>
        ) : (
          upcoming.map(({ mark, index }) => (
            <MarkRow
              key={index}
              mark={mark}
              readOnly={readOnly}
              picked={picked === index}
              lengthText={lengthLabel({ from: stampToMin(mark.start), to: stampToMin(mark.end) })}
              onChange={(next) => change(next ? editMark(marks, index, next) : marks.filter((_, i) => i !== index))}
              t={t}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** One mark, set to the minute. A value is taken once it is a whole, sensible date: typing goes through odd ones. */
function MarkRow({
  mark,
  readOnly,
  picked,
  lengthText,
  onChange,
  t,
}: {
  mark: QueueStaffedMark;
  readOnly: boolean;
  /** Tapped on the calendar: brought into view and outlined. */
  picked: boolean;
  lengthText: string;
  /** The mark changed, or null: removed. */
  onChange: (mark: QueueStaffedMark | null) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [start, setStart] = useState(mark.start);
  const [end, setEnd] = useState(mark.end);
  useEffect(() => {
    setStart(mark.start);
    setEnd(mark.end);
  }, [mark.start, mark.end]);
  const away = mark.kind === 'away';
  const Icon = away ? UserX : UserCheck;
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (picked) rowRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [picked]);

  const takeStart = (value: string) => {
    setStart(value);
    if (!plausible(value)) return;
    // Moving the start moves the whole stretch, as calendars do.
    const from = stampToMin(value);
    const length = stampToMin(mark.end) - stampToMin(mark.start);
    onChange({ ...mark, start: minToStamp(from), end: minToStamp(from + length) });
  };
  const takeEnd = (value: string) => {
    setEnd(value);
    if (!plausible(value)) return;
    const from = stampToMin(mark.start);
    const to = stampToMin(value);
    if (to > from && to - from <= MAX_LENGTH) onChange({ ...mark, end: minToStamp(to) });
  };
  const inputClass =
    'min-w-0 flex-1 basis-40 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm [color-scheme:dark]';

  return (
    <div
      ref={rowRef}
      className={`rounded-lg border bg-bambu-dark/50 p-2 space-y-2 transition-colors ${
        picked ? 'border-white/60' : 'border-bambu-dark-tertiary'
      }`}
      data-testid="staffed-mark-row"
      data-picked={picked || undefined}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onChange({ ...mark, kind: away ? 'here' : 'away' })}
          title={readOnly ? undefined : t('queue.timeline.staffed.toggleKind')}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border ${
            away ? 'border-red-400/40 bg-red-500/10 text-red-200' : 'border-bambu-green/40 bg-bambu-green/10 text-bambu-green'
          } ${readOnly ? '' : 'hover:brightness-125'}`}
        >
          <Icon className="w-3.5 h-3.5" />
          {away ? t('queue.timeline.staffed.brushAway') : t('queue.timeline.staffed.brushHere')}
        </button>
        <span className="flex-1 text-xs text-bambu-gray tabular-nums">{lengthText}</span>
        {!readOnly && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t('queue.timeline.staffed.removeMark')}
            title={t('queue.timeline.staffed.removeMark')}
            className="p-1 rounded text-bambu-gray hover:text-red-300 hover:bg-bambu-dark-tertiary"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="datetime-local"
          step={900}
          value={start}
          disabled={readOnly}
          onChange={(e) => takeStart(e.target.value)}
          onBlur={() => setStart(mark.start)}
          aria-label={t('queue.timeline.staffed.from')}
          className={inputClass}
        />
        <span className="text-bambu-gray">→</span>
        <input
          type="datetime-local"
          step={900}
          value={end}
          disabled={readOnly}
          onChange={(e) => takeEnd(e.target.value)}
          onBlur={() => setEnd(mark.end)}
          aria-label={t('queue.timeline.staffed.to')}
          className={inputClass}
        />
      </div>
    </div>
  );
}
