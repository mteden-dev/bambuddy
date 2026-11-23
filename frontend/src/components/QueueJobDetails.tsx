import { useEffect, useState } from 'react';
import {
  CalendarClock,
  Clock,
  Layers,
  Lock,
  LockOpen,
  Pencil,
  Pin,
  PinOff,
  Scale,
  Shuffle,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react';

import type { PrintQueueItem, Printer, QueueForecastVariant } from '../api/client';
import { formatDuration, parseUTCDate } from '../utils/date';
import { queueJobModels, queueJobName, queueJobPrintTime, queueJobThumbnailUrl } from '../utils/queueJobDisplay';
import { Button } from './Button';
import { QueueItemTagChips } from './QueueItemTagChips';

/** Where a job is sent: one printer, or back to any printer of a model. */
export type QueuePinTarget = { printer_id: number } | { target_model: string };

export interface QueueJobDetailsProps {
  item: PrintQueueItem;
  printers: Printer[];
  /** Where the timeline expects the job, when it is on a lane. */
  expected?: { printerId: number; start: Date; end: Date } | null;
  /** For a job with alternatives: the one the expected printer takes. */
  variant?: QueueForecastVariant | null;
  /** The printer the timeline's plan holds this "Any" job for, and whether that holds now. */
  reservation?: { printer: string; active: boolean } | null;
  /** Hand the job back to any printer of its model. */
  onReleaseReservation?: () => void;
  /** A running print's progress (0-100). */
  progress?: number | null;
  /** Why the job is not on the timeline, worded for the user. */
  heldReason?: string | null;
  /** Printers the job may be pinned to (other than the one it is pinned to). */
  pinChoices: Printer[];
  /** Printer to preselect in the pin choice (a lane the job was dropped on). */
  suggestedPrinterId?: number | null;
  canModify: boolean;
  onPin?: (target: QueuePinTarget) => void;
  onEdit?: () => void;
  onCancel?: () => void;
  onStop?: () => void;
  onClose: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function formatTime(date: Date): string {
  return date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function swatches(item: PrintQueueItem): { type: string; color: string }[] {
  if (item.filament_overrides?.length) return item.filament_overrides.map((o) => ({ type: o.type, color: o.color }));
  if (item.filament_color) {
    const types = (item.filament_type ?? '').split(',');
    return item.filament_color.split(',').map((color, i) => ({ type: types[i]?.trim() ?? types[0] ?? '', color: color.trim() }));
  }
  return (item.required_filament_types ?? []).map((type) => ({ type, color: '' }));
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="mt-0.5 text-bambu-gray shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-bambu-gray">{label}</div>
        <div className="text-sm text-white break-words">{children}</div>
      </div>
    </div>
  );
}

/**
 * A queued job at a glance, opened from the timeline (fork): a large
 * thumbnail, the name, where and when it is expected to run, print time,
 * weight and filament. Pinning to a printer is chosen here, on purpose:
 * dragging on the timeline only changes the order.
 */
export function QueueJobDetails({
  item,
  printers,
  expected,
  variant,
  reservation,
  onReleaseReservation,
  progress,
  heldReason,
  pinChoices,
  suggestedPrinterId,
  canModify,
  onPin,
  onEdit,
  onCancel,
  onStop,
  onClose,
  t,
}: QueueJobDetailsProps) {
  const pinned = item.printer_id != null;
  const isPrinting = item.status === 'printing';
  const hasAlternatives = (item.variants?.length ?? 0) > 0;
  const nameOf = (id: number | null | undefined) =>
    id == null ? '' : printers.find((p) => p.id === id)?.name ?? `#${id}`;
  const pinnedPrinter = pinned ? printers.find((p) => p.id === item.printer_id) : undefined;
  const unpinModel = pinnedPrinter?.model ?? null;

  const defaultChoice =
    (suggestedPrinterId != null && pinChoices.some((p) => p.id === suggestedPrinterId) && suggestedPrinterId) ||
    (expected && pinChoices.some((p) => p.id === expected.printerId) && expected.printerId) ||
    pinChoices[0]?.id ||
    null;
  const [choice, setChoice] = useState<number | null>(defaultChoice);
  useEffect(() => setChoice(defaultChoice), [defaultChoice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = queueJobName(item, variant);
  const thumbnail = queueJobThumbnailUrl(item, variant);
  const printTime = queueJobPrintTime(item, variant);
  const plate = variant ? variant.plate_id : item.plate_id;
  const scheduled = parseUTCDate(item.scheduled_time);
  const added = parseUTCDate(item.created_at);
  const filaments = swatches(item);
  const where = pinned
    ? t('queue.timeline.details.pinned', { printer: nameOf(item.printer_id) })
    : hasAlternatives
      ? `${t('queue.filter.any')} ${queueJobModels(item).join(' / ')}`
      : item.target_model
        ? `${t('queue.filter.any')} ${item.target_model}${item.target_location ? ` @ ${item.target_location}` : ''}`
        : t('queue.filter.unassigned');
  const status = isPrinting
    ? progress != null
      ? t('queue.timeline.details.printingProgress', { progress: Math.round(progress) })
      : t('queue.timeline.legend.printing')
    : heldReason || item.waiting_reason || t('queue.timeline.details.pending');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('queue.timeline.details.title')}
        data-testid="queue-job-details"
        className="w-full sm:max-w-xl max-h-[90vh] overflow-y-auto bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-4 p-4 sm:p-5 border-b border-bambu-dark-tertiary">
          <div className="w-28 h-28 sm:w-36 sm:h-36 shrink-0 rounded-xl bg-bambu-dark overflow-hidden flex items-center justify-center">
            {thumbnail ? (
              <img src={thumbnail} alt="" className="w-full h-full object-cover" />
            ) : (
              <Layers className="w-10 h-10 text-bambu-gray/40" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg sm:text-xl font-semibold text-white break-words">{name}</h2>
              <button
                type="button"
                onClick={onClose}
                className="p-1 -mr-1 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
                aria-label={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div
              className={`mt-1 inline-flex items-center gap-1.5 text-sm ${pinned ? 'text-bambu-green' : 'text-blue-600 dark:text-blue-400'}`}
            >
              {pinned ? <Pin className="w-3.5 h-3.5" /> : <Shuffle className="w-3.5 h-3.5" />}
              <span className="break-words">{where}</span>
            </div>
            {!pinned && expected && (
              <div className="text-xs text-bambu-gray mt-0.5">
                {variant
                  ? t('queue.timeline.details.expectedVersion', {
                      printer: nameOf(expected.printerId),
                      model: variant.target_model,
                    })
                  : t('queue.timeline.details.expected', { printer: nameOf(expected.printerId) })}
              </div>
            )}
            <div className="mt-2 text-xs text-bambu-gray break-words">{status}</div>
            {isPrinting && progress != null && (
              <div className="mt-2 h-1.5 rounded-full bg-bambu-dark overflow-hidden">
                <div className="h-full bg-blue-400" style={{ width: `${progress}%` }} />
              </div>
            )}
            <div className="mt-2">
              <QueueItemTagChips item={item} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:p-5">
          {expected && (
            <Row icon={<CalendarClock className="w-4 h-4" />} label={t('queue.timeline.details.when')}>
              {formatTime(expected.start)} → {formatTime(expected.end)}
            </Row>
          )}
          {printTime ? (
            <Row icon={<Clock className="w-4 h-4" />} label={t('queue.timeline.details.printTime')}>
              {formatDuration(printTime)}
            </Row>
          ) : null}
          {item.filament_used_grams ? (
            <Row icon={<Scale className="w-4 h-4" />} label={t('queue.timeline.details.weight')}>
              {Math.round(item.filament_used_grams)} g
            </Row>
          ) : null}
          {filaments.length > 0 && (
            <Row icon={<Layers className="w-4 h-4" />} label={t('queue.timeline.details.filament')}>
              <span className="flex flex-wrap items-center gap-1.5">
                {filaments.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1">
                    {f.color && (
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-white/20"
                        style={{ backgroundColor: f.color.startsWith('#') ? f.color : `#${f.color}` }}
                      />
                    )}
                    <span className="text-xs">{f.type}</span>
                  </span>
                ))}
              </span>
            </Row>
          )}
          {plate != null && (
            <Row icon={<Layers className="w-4 h-4" />} label={t('queue.timeline.details.plate')}>
              {plate}
            </Row>
          )}
          {item.batch_name && (
            <Row icon={<Layers className="w-4 h-4" />} label={t('queue.timeline.details.batch')}>
              {item.batch_name}
            </Row>
          )}
          {scheduled && (
            <Row icon={<CalendarClock className="w-4 h-4" />} label={t('queue.timeline.details.scheduled')}>
              {formatTime(scheduled)}
            </Row>
          )}
          {(item.created_by_username || added) && (
            <Row icon={<User className="w-4 h-4" />} label={t('queue.timeline.details.added')}>
              {[item.created_by_username, added ? formatTime(added) : null].filter(Boolean).join(' · ')}
            </Row>
          )}
        </div>

        {/* Held for a printer by the timeline's plan, until it starts or is released. */}
        {!isPrinting && reservation && (
          <div
            className="mx-4 sm:mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2"
            data-testid="queue-job-reservation"
          >
            <Lock className="w-4 h-4 text-amber-300 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white">
                {t('queue.timeline.details.reserved', { printer: reservation.printer })}
              </div>
              <div className="text-xs text-bambu-gray">
                {reservation.active
                  ? t('queue.timeline.details.reservedHelp')
                  : t('queue.timeline.details.reservedInactive')}
              </div>
            </div>
            {onReleaseReservation && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onReleaseReservation}
                disabled={!canModify}
                title={!canModify ? t('queue.timeline.details.noPermission') : undefined}
              >
                <LockOpen className="w-4 h-4" />
                {t('queue.timeline.details.release')}
              </Button>
            )}
          </div>
        )}

        {/* Pinning: the one place a job is tied to (or freed from) a printer. */}
        {!isPrinting && onPin && (
          <div className="px-4 sm:px-5 pb-4 space-y-2" data-testid="queue-job-pin">
            {hasAlternatives ? (
              <p className="text-xs text-bambu-gray">{t('queue.timeline.details.alternatives')}</p>
            ) : (
              <>
                <div className="text-xs font-medium text-bambu-gray">
                  {pinned ? t('queue.timeline.details.moveTo') : t('queue.timeline.details.pinTo')}
                </div>
                {pinChoices.length > 0 ? (
                  <div className="flex gap-2">
                    <select
                      value={choice ?? ''}
                      onChange={(e) => setChoice(Number(e.target.value))}
                      disabled={!canModify}
                      aria-label={pinned ? t('queue.timeline.details.moveTo') : t('queue.timeline.details.pinTo')}
                      className="flex-1 min-w-0 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
                    >
                      {pinChoices.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      onClick={() => choice != null && onPin({ printer_id: choice })}
                      disabled={!canModify || choice == null}
                      title={!canModify ? t('queue.timeline.details.noPermission') : undefined}
                    >
                      <Pin className="w-4 h-4" />
                      {pinned ? t('queue.timeline.details.moveButton') : t('queue.timeline.details.pinButton')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-bambu-gray">{t('queue.timeline.details.noPinChoices')}</p>
                )}
                {pinned && unpinModel && (
                  <Button
                    variant="secondary"
                    onClick={() => onPin({ target_model: unpinModel })}
                    disabled={!canModify}
                    title={!canModify ? t('queue.timeline.details.noPermission') : undefined}
                  >
                    <PinOff className="w-4 h-4" />
                    {t('queue.timeline.details.unpin', { model: unpinModel })}
                  </Button>
                )}
                <p className="text-[11px] text-bambu-gray/80">{t('queue.timeline.details.pinHelp')}</p>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 px-4 sm:px-5 py-3 border-t border-bambu-dark-tertiary">
          {isPrinting
            ? onStop && (
                <Button variant="danger" onClick={onStop} disabled={!canModify}>
                  <Square className="w-4 h-4" />
                  {t('queue.timeline.details.stop')}
                </Button>
              )
            : onCancel && (
                <Button variant="danger" onClick={onCancel} disabled={!canModify}>
                  <Trash2 className="w-4 h-4" />
                  {t('queue.timeline.details.cancel')}
                </Button>
              )}
          {!isPrinting && onEdit && (
            <Button variant="secondary" onClick={onEdit} disabled={!canModify}>
              <Pencil className="w-4 h-4" />
              {t('queue.timeline.details.edit')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
