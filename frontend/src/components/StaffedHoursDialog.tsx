import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, type QueueStaffedHours } from '../api/client';
import { Button } from './Button';

/** The browser's time zone, for hours entered here. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const DEFAULT_DAY = { start: '07:00', end: '22:00' };

/**
 * When someone is at the farm to clear finished plates (fork,
 * services/staffed_hours.py). With plate-clear confirmation on, the timeline
 * forecasts a printer that finishes outside these hours as standing until
 * someone comes and clears it.
 */
export function StaffedHoursDialog({
  canEdit,
  waitsForPlate,
  onClose,
  t,
}: {
  canEdit: boolean;
  /** Plate-clear confirmation is on, so the hours change the forecast. */
  waitsForPlate: boolean;
  onClose: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: stored, isLoading } = useQuery({ queryKey: ['queue', 'staffed-hours'], queryFn: api.getStaffedHours });
  const [hours, setHours] = useState<QueueStaffedHours | null>(null);
  useEffect(() => {
    if (stored && !hours) {
      // Never set up: hours are entered in this browser's time zone.
      setHours(!stored.enabled && stored.timezone === 'UTC' ? { ...stored, timezone: browserZone() } : stored);
    }
  }, [stored, hours]);

  const save = useMutation({
    mutationFn: (value: QueueStaffedHours) => api.updateStaffedHours(value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      onClose();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 1 January 2024 was a Monday.
  const dayNames = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(i18n.language, { weekday: 'long' }),
  );
  const setDay = (index: number, value: QueueStaffedHours['days'][number]) =>
    setHours((h) => (h ? { ...h, days: h.days.map((d, i) => (i === index ? value : d)) } : h));
  const readOnly = !canEdit;
  const zone = browserZone();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('queue.timeline.staffed.title')}
        data-testid="staffed-hours-dialog"
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 p-4 sm:p-5 border-b border-bambu-dark-tertiary">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-bambu-green" />
              {t('queue.timeline.staffed.title')}
            </h2>
            <p className="text-xs text-bambu-gray mt-1">{t('queue.timeline.staffed.description')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 -mr-1 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading || !hours ? (
          <div className="p-5 text-sm text-bambu-gray">{t('common.loading')}</div>
        ) : (
          <div className="p-4 sm:p-5 space-y-4">
            {!waitsForPlate && (
              <p className="text-xs rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-200 px-3 py-2" data-testid="staffed-no-plate-clear">
                {t('queue.timeline.staffed.noPlateClear')}
              </p>
            )}
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
                  <div key={index} className="flex items-center gap-2" data-testid={`staffed-day-${index}`}>
                    <label className="flex items-center gap-2 w-36 shrink-0 text-sm text-white capitalize">
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
                          className="px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm"
                        />
                        <span className="text-bambu-gray">–</span>
                        <input
                          type="time"
                          value={day.end}
                          disabled={readOnly || !hours.enabled}
                          onChange={(e) => e.target.value && setDay(index, { ...day, end: e.target.value })}
                          aria-label={`${name} ${t('queue.timeline.staffed.to')}`}
                          className="px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm"
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

        <div className="flex justify-end gap-2 px-4 sm:px-5 py-3 border-t border-bambu-dark-tertiary">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {canEdit && (
            <Button onClick={() => hours && save.mutate(hours)} disabled={!hours || save.isPending}>
              {t('common.save')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
