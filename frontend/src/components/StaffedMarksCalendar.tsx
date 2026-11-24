import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Eraser, Trash2, UserCheck, UserX } from 'lucide-react';
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
// A drag snaps to half hours; a tap marks the hour under the finger.
const SNAP = 30;
const TAP = 60;
const MAX_LENGTH = 31 * DAY_MIN;
// Further than this from where it went down, the pointer is dragging, not tapping.
const DRAG_PX = 5;

type Brush = QueueStaffedMarkKind | 'erase';

const KIND_STYLE: Record<QueueStaffedMarkKind, { className: string; image?: string }> = {
  away: { className: '', image: AWAY_STRIPES },
  here: { className: 'bg-bambu-green/70' },
};

interface Drag {
  anchor: number;
  current: number;
  x: number;
  y: number;
  moved: boolean;
}

/** The stretch a drag (or a tap) covers. */
function dragSpan(drag: Drag): Span {
  if (!drag.moved) {
    const from = Math.floor(drag.anchor / TAP) * TAP;
    return { from, to: from + TAP };
  }
  const from = Math.round(Math.min(drag.anchor, drag.current) / SNAP) * SNAP;
  const to = Math.round(Math.max(drag.anchor, drag.current) / SNAP) * SNAP;
  return { from, to: Math.max(to, from + SNAP) };
}

const plausible = (value: string) => {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value);
  return match != null && Number(match[1]) >= 2000 && Number(match[1]) <= 2100;
};

/**
 * Marks on given dates (fork, services/staffed_hours.py): the coming two
 * weeks, a row a day, in the farm's time zone. Dragging over the rows marks
 * the hours with the chosen brush, across midnight into the next row too;
 * the list below sets them to the minute.
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
  const gridRef = useRef<HTMLDivElement>(null);

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

  const pointToMin = (clientX: number, clientY: number): number => {
    const rect = gridRef.current!.getBoundingClientRect();
    const row = Math.min(DAYS - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * DAYS)));
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return rows[row] + fraction * DAY_MIN;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const at = pointToMin(e.clientX, e.clientY);
    setDrag({ anchor: at, current: at, x: e.clientX, y: e.clientY, moved: false });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_PX;
    setDrag({ ...drag, current: pointToMin(e.clientX, e.clientY), moved });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const { from, to } = dragSpan(drag);
    setDrag(null);
    onChange(paintMarks(marks, from, to, brush === 'erase' ? null : brush));
  };

  const preview = drag ? dragSpan(drag) : null;
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

      {/* What a drag covers, while dragging; how to mark, otherwise. */}
      <div className="h-4 text-[11px] flex items-center gap-1.5" aria-live="polite">
        {preview ? (
          <>
            <span
              className={`inline-block w-3 h-3 rounded-sm ${brush === 'erase' ? 'bg-white/30' : KIND_STYLE[brush].className}`}
              style={brush === 'away' ? { backgroundImage: AWAY_STRIPES } : undefined}
            />
            <span className="text-white tabular-nums">{rangeLabel(preview)}</span>
            <span className="text-bambu-gray">· {lengthLabel(preview)}</span>
          </>
        ) : (
          <span className="text-bambu-gray">{readOnly ? '' : t('queue.timeline.staffed.dragHint')}</span>
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
            className={`relative flex-1 ${readOnly ? '' : 'cursor-crosshair'}`}
            style={{ touchAction: readOnly ? undefined : 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
            data-testid="staffed-calendar-grid"
          >
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
                  {clipSpans(spans, row, row + DAY_MIN).map((span) => (
                    <div
                      key={`${span.kind}-${span.from}`}
                      className={`absolute inset-y-0 ${KIND_STYLE[span.kind].className}`}
                      style={{ ...at(span, row), backgroundImage: KIND_STYLE[span.kind].image }}
                      data-testid="staffed-mark"
                      data-kind={span.kind}
                    />
                  ))}
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
              onClick={() => onChange(marks.filter((m) => stampToMin(m.end) <= nowMin))}
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
              lengthText={lengthLabel({ from: stampToMin(mark.start), to: stampToMin(mark.end) })}
              onChange={(next) => onChange(next ? editMark(marks, index, next) : marks.filter((_, i) => i !== index))}
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
  lengthText,
  onChange,
  t,
}: {
  mark: QueueStaffedMark;
  readOnly: boolean;
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
    <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/50 p-2 space-y-2" data-testid="staffed-mark-row">
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
