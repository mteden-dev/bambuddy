import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarDays, Loader2, Repeat, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, type QueueStaffedHours, type QueueStaffedHoursView } from '../api/client';
import { formatDuration } from '../utils/date';
import { stampToMin, zoneNowMin } from '../utils/staffedMarks';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { Button } from './Button';
import { StaffedMarksCalendar } from './StaffedMarksCalendar';

/** The browser's time zone, for hours entered here. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const DEFAULT_DAY = { start: '07:00', end: '22:00' };

// The usual wait of a plate finished in that hour, as a shade: quick to long.
function waitShade(minutes: number): string {
  if (minutes <= 15) return 'bg-bambu-green/70';
  if (minutes <= 60) return 'bg-bambu-green/30';
  if (minutes <= 240) return 'bg-amber-500/50';
  return 'bg-red-500/50';
}
const SHADE_SCALE: Array<[string, string]> = [
  ['quick', 'bg-bambu-green/70'],
  ['hour', 'bg-bambu-green/30'],
  ['hours', 'bg-amber-500/50'],
  ['long', 'bg-red-500/50'],
];

/**
 * When someone is at the farm to clear finished plates (fork,
 * services/staffed_hours.py). With plate-clear confirmation on, the timeline
 * forecasts a printer that finishes outside these hours as standing until
 * someone comes and clears it. The calendar marks given dates; the other tab
 * holds the usual week and what the forecast learned.
 */
export function StaffedHoursDialog({
  canEdit,
  waitsForPlate,
  awayUntil = null,
  present = false,
  initialTab = 'calendar',
  onClose,
  t,
}: {
  canEdit: boolean;
  initialTab?: 'calendar' | 'week';
  /** Plate-clear confirmation is on, so the hours change the forecast. */
  waitsForPlate: boolean;
  /** The forecast takes it nobody is there until then (formatted), from a plate waiting far longer than usual. */
  awayUntil?: string | null;
  /** Someone cleared a plate a moment ago. */
  present?: boolean;
  onClose: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: stored, isLoading } = useQuery<QueueStaffedHoursView>({
    queryKey: ['queue', 'staffed-hours'],
    queryFn: api.getStaffedHours,
  });
  const [hours, setHours] = useState<QueueStaffedHours | null>(null);
  // As loaded, to tell whether anything was changed (fork).
  const [loaded, setLoaded] = useState<QueueStaffedHours | null>(null);
  useEffect(() => {
    if (stored && !hours) {
      // Never set up: hours are entered in this browser's time zone.
      const initial = {
        enabled: stored.enabled,
        timezone: !stored.enabled && stored.timezone === 'UTC' ? browserZone() : stored.timezone,
        days: stored.days,
        clear_minutes: stored.clear_minutes,
        learn: stored.learn ?? true,
        marks: stored.marks ?? [],
      };
      setHours(initial);
      setLoaded(initial);
    }
  }, [stored, hours]);
  const dirty = hours != null && loaded != null && JSON.stringify(hours) !== JSON.stringify(loaded);
  // Closing with changes asks first (fork): a tap beside the sheet must not drop painted marks.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const learned = stored?.learned ?? null;
  const [tab, setTab] = useState<'calendar' | 'week'>(initialTab);

  const save = useMutation({
    mutationFn: (value: QueueStaffedHours) => api.updateStaffedHours(value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      onClose();
    },
  });
  const requestClose = () => {
    // A save under way keeps the dialog: its outcome shows here.
    if (save.isPending) return;
    if (dirty && canEdit) setConfirmDiscard(true);
    else onClose();
  };
  // The heat map's hour tapped: its usual wait, said below the map.
  const [heatCell, setHeatCell] = useState<number | null>(null);

  // Escape, and a phone's Back on the bottom sheet, ask like Cancel does;
  // asked already, they go back to editing.
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(() => (confirmDiscard ? setConfirmDiscard(false) : requestClose()), dialogRef, {
    busy: save.isPending,
    backCloses: 'narrow',
  });

  // 1 January 2024 was a Monday.
  const dayNames = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(i18n.language, { weekday: 'long' }),
  );
  const shortDayNames = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(i18n.language, { weekday: 'short' }),
  );
  // The heat map's words for one hour of the week, Monday 00:00 first.
  const heatText = (cell: number) =>
    t('queue.timeline.staffed.heatmapCell', {
      day: dayNames[Math.floor(cell / 24)],
      hour: `${String(cell % 24).padStart(2, '0')}:00`,
      duration: formatDuration((learned?.typical_minutes?.[cell] ?? 0) * 60),
    });
  const setDay = (index: number, value: QueueStaffedHours['days'][number]) =>
    setHours((h) => (h ? { ...h, days: h.days.map((d, i) => (i === index ? value : d)) } : h));
  const readOnly = !canEdit;
  const zone = browserZone();
  const upcomingMarks = hours
    ? (hours.marks ?? []).filter((m) => stampToMin(m.end) > zoneNowMin(hours.timezone)).length
    : 0;
  const tabs = [
    { key: 'calendar' as const, icon: CalendarDays, label: t('queue.timeline.staffed.tabCalendar'), count: upcomingMarks },
    { key: 'week' as const, icon: Repeat, label: t('queue.timeline.staffed.tabWeek'), count: 0 },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4" onClick={requestClose} role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('queue.timeline.staffed.title')}
        data-testid="staffed-hours-dialog"
        className="outline-none w-full sm:max-w-2xl max-h-[90vh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-start justify-between gap-2 p-4 sm:p-5 border-b border-bambu-dark-tertiary">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-bambu-green" />
              {t('queue.timeline.staffed.title')}
            </h2>
            <p className="text-xs text-bambu-gray mt-1">{t('queue.timeline.staffed.description')}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="p-1 -mr-1 shrink-0 inline-flex items-center justify-center rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary any-pointer-coarse:min-w-[44px] any-pointer-coarse:min-h-[44px]"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Fork: the body scrolls; Save below stays in view. */}
        {isLoading || !hours ? (
          <div className="p-5 text-sm text-bambu-gray flex-1 min-h-0">{t('common.loading')}</div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4" data-testid="staffed-hours-body">
            {!waitsForPlate && (
              <p className="text-xs rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-200 px-3 py-2" data-testid="staffed-no-plate-clear">
                {t('queue.timeline.staffed.noPlateClear')}
              </p>
            )}
            <div className="flex gap-1 p-1 rounded-lg bg-bambu-dark border border-bambu-dark-tertiary" role="tablist">
              {tabs.map(({ key, icon: Icon, label, count }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  data-testid={`staffed-tab-${key}`}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                    tab === key ? 'bg-bambu-dark-tertiary text-white shadow-sm' : 'text-bambu-gray hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="truncate">{label}</span>
                  {count > 0 && (
                    <span className="min-w-5 px-1.5 rounded-full bg-red-500/20 text-red-200 text-[11px] leading-5">{count}</span>
                  )}
                </button>
              ))}
            </div>

            {tab === 'calendar' ? (
              <StaffedMarksCalendar
                marks={hours.marks ?? []}
                onChange={(marks) => setHours((h) => (h ? { ...h, marks } : h))}
                timezone={hours.timezone}
                days={hours.days}
                weeklyEnabled={hours.enabled}
                readOnly={readOnly}
                t={t}
              />
            ) : (
              <>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-white">{t('queue.timeline.staffed.enabled')}</span>
                <input
                  type="checkbox"
                  checked={hours.enabled}
                  disabled={readOnly}
                  onChange={(e) => setHours({ ...hours, enabled: e.target.checked })}
                  className="w-4 h-4 accent-bambu-green"
                />
              </label>

              <div className={`space-y-2 ${hours.enabled ? '' : 'opacity-50'}`}>
                {dayNames.map((name, index) => {
                  const day = hours.days[index];
                  return (
                    // Fork: the day's name over its hours on a phone, beside them from sm.
                    <div key={index} className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1" data-testid={`staffed-day-${index}`}>
                      <label className="flex items-center gap-2 w-full sm:w-36 shrink-0 text-sm text-white capitalize any-pointer-coarse:min-h-[44px]">
                        <input
                          type="checkbox"
                          checked={day != null}
                          disabled={readOnly || !hours.enabled}
                          onChange={(e) => setDay(index, e.target.checked ? DEFAULT_DAY : null)}
                          className="w-4 h-4 accent-bambu-green"
                        />
                        {name}
                      </label>
                      {day ? (
                        <>
                          <input
                            type="time"
                            value={day.start}
                            disabled={readOnly || !hours.enabled}
                            onChange={(e) => e.target.value && setDay(index, { ...day, start: e.target.value })}
                            aria-label={`${name} ${t('queue.timeline.staffed.from')}`}
                            className="min-w-0 flex-1 sm:flex-none px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm any-pointer-coarse:min-h-[44px]"
                          />
                          <span className="text-bambu-gray">–</span>
                          <input
                            type="time"
                            value={day.end}
                            disabled={readOnly || !hours.enabled}
                            onChange={(e) => e.target.value && setDay(index, { ...day, end: e.target.value })}
                            aria-label={`${name} ${t('queue.timeline.staffed.to')}`}
                            className="min-w-0 flex-1 sm:flex-none px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm any-pointer-coarse:min-h-[44px]"
                          />
                        </>
                      ) : (
                        <span className="text-xs text-bambu-gray">{t('queue.timeline.staffed.dayOff')}</span>
                      )}
                    </div>
                  );
                })}
                <p className="text-[11px] text-bambu-gray">{t('queue.timeline.staffed.overnight')}</p>
              </div>

              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-white">
                  {t('queue.timeline.staffed.clearMinutes')}
                  <span className="block text-xs text-bambu-gray">{t('queue.timeline.staffed.clearMinutesHelp')}</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={hours.clear_minutes}
                  disabled={readOnly}
                  onChange={(e) => setHours({ ...hours, clear_minutes: Math.max(0, Math.min(240, Number(e.target.value) || 0)) })}
                  className="w-20 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm"
                />
              </label>

              <div className="space-y-2 pt-3 border-t border-bambu-dark-tertiary" data-testid="staffed-learn">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm text-white">
                    {t('queue.timeline.staffed.learn')}
                    <span className="block text-xs text-bambu-gray">{t('queue.timeline.staffed.learnHelp')}</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={hours.learn}
                    disabled={readOnly}
                    onChange={(e) => setHours({ ...hours, learn: e.target.checked })}
                    className="w-4 h-4 accent-bambu-green shrink-0"
                  />
                </label>
                {hours.learn && waitsForPlate && (awayUntil || present) && (
                  <p
                    className={`text-xs rounded-lg px-3 py-2 border ${
                      awayUntil ? 'border-amber-400/40 bg-amber-500/10 text-amber-200' : 'border-bambu-green/40 bg-bambu-green/10 text-bambu-green'
                    }`}
                    data-testid="staffed-now"
                  >
                    {awayUntil
                      ? t('queue.timeline.staffed.nowAway', { time: awayUntil })
                      : t('queue.timeline.staffed.nowPresent')}
                  </p>
                )}
                {hours.learn && learned && (
                  learned.typical_minutes ? (
                    <div className="space-y-1.5">
                      <p className="text-xs text-bambu-gray">
                        {t('queue.timeline.staffed.learnedFrom', { count: learned.samples })}
                      </p>
                      <div
                        className="grid gap-px text-[9px] text-bambu-gray"
                        style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
                        data-testid="staffed-heatmap"
                      >
                        <span />
                        {Array.from({ length: 24 }, (_, h) => (
                          <span key={h} className="text-center leading-3">{h % 6 === 0 ? h : ''}</span>
                        ))}
                        {shortDayNames.map((day, d) => (
                          <div key={day} className="contents">
                            <span className="pr-1 leading-4 capitalize">{day}</span>
                            {Array.from({ length: 24 }, (_, h) => {
                              const minutes = learned.typical_minutes![d * 24 + h];
                              const cell = d * 24 + h;
                              return (
                                <button
                                  type="button"
                                  key={h}
                                  onClick={() => setHeatCell(cell)}
                                  className={`h-4 rounded-[2px] ${waitShade(minutes)} ${heatCell === cell ? 'ring-2 ring-white' : ''}`}
                                  title={heatText(cell)}
                                  aria-label={heatText(cell)}
                                  data-testid="staffed-heat-cell"
                                />
                              );
                            })}
                          </div>
                        ))}
                      </div>
                      {/* The hour tapped, as a hover says it on a desktop. */}
                      <p className="text-xs text-white min-h-4" aria-live="polite" data-testid="staffed-heat-info">
                        {heatCell != null ? heatText(heatCell) : t('queue.timeline.staffed.heatmapTap')}
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-bambu-gray">
                        {SHADE_SCALE.map(([key, shade]) => (
                          <span key={key} className="flex items-center gap-1">
                            <span className={`inline-block w-3 h-3 rounded-[2px] ${shade}`} />
                            {t(`queue.timeline.staffed.scale.${key}`)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-bambu-gray" data-testid="staffed-too-few">
                      {t('queue.timeline.staffed.learnedTooFew', { count: learned.samples, needed: learned.needed })}
                    </p>
                  )
                )}
              </div>
              </>
            )}

            <div className="text-xs text-bambu-gray flex flex-wrap items-center gap-2">
              {t('queue.timeline.staffed.timezone', { zone: hours.timezone })}
              {hours.timezone !== zone && !readOnly && (
                <button type="button" className="text-bambu-green hover:underline" onClick={() => setHours({ ...hours, timezone: zone })}>
                  {t('queue.timeline.staffed.useBrowserZone', { zone })}
                </button>
              )}
            </div>
            {save.isError && (
              <p className="text-xs text-red-400">{t('queue.timeline.staffed.saveFailed')}</p>
            )}
          </div>
        )}

        <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-4 sm:px-5 py-3 border-t border-bambu-dark-tertiary" data-testid="staffed-hours-footer">
          {confirmDiscard ? (
            <>
              <span className="mr-auto text-sm text-white" role="alert" data-testid="staffed-discard-ask">
                {t('queue.timeline.staffed.discardAsk')}
              </span>
              <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                {t('queue.timeline.staffed.keepEditing')}
              </Button>
              <Button variant="danger" onClick={onClose}>
                {t('queue.timeline.staffed.discard')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={requestClose} disabled={save.isPending}>
                {t('common.cancel')}
              </Button>
              {canEdit && (
                <Button onClick={() => hours && save.mutate(hours)} disabled={!hours || save.isPending}>
                  {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('common.save')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
