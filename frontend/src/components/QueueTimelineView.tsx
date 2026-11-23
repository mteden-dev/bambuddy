import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, Clock, Layers, Pin, Printer as PrinterIcon, Shuffle, Undo2 } from 'lucide-react';
import { formatDuration, parseUTCDate } from '../utils/date';
import { api } from '../api/client';
import type { PrintQueueItem, Printer, QueueForecast, QueueForecastRefusal } from '../api/client';
import { queueItemThumbnailUrl } from '../utils/queueItemThumbnail';
import { Button } from './Button';

/** Gantt-style 24h-rolling timeline. One horizontal swimlane per printer. A
 *  print that is running is drawn from the printer's live status; every
 *  pending job is drawn where the server's forecast (GET /queue/forecast)
 *  expects the scheduler to run it, including jobs for "Any <model>", which
 *  land on the printer they are expected to get (drawn dashed, as a forecast,
 *  while jobs pinned to a printer are solid). A job that has not started can
 *  be dragged onto another printer; printers it may not go on (another model,
 *  outside its location, printer tags…) refuse the drop and say why. */

const HOUR_MS = 60 * 60 * 1000;
const RANGE_HOURS = 24;
const RANGE_MS = RANGE_HOURS * HOUR_MS;
// Minimum bar width — short prints (a few minutes) would otherwise render as
// 1-2px slivers and be unclickable. 32px keeps them at thumb size.
const MIN_BAR_PX = 32;
// Lane height for the bar row + label.
const LANE_BAR_HEIGHT_PX = 40;
const ANY_MODEL_DROP_ID = 'any-model';
// The lane under the pointer (or finger) is the target. Overlap with the
// dragged tile would pick the lane below the thin "back to any" strip.
const pointerFirst: CollisionDetection = (args) => {
  const underPointer = pointerWithin(args);
  return underPointer.length > 0 ? underPointer : rectIntersection(args);
};
// GET /queue/forecast's off_timeline reasons -> queue.timeline.offTimeline.* keys.
const OFF_TIMELINE_KEYS: Record<string, string> = {
  manual_start: 'manualStart',
  waiting: 'waiting',
  no_printer: 'noPrinter',
  unassigned: 'unassigned',
  starting: 'starting',
};

interface ScheduleEvent {
  item: PrintQueueItem;
  estimatedStart: Date;
  estimatedEnd: Date;
  progress?: number;
  type: 'printing' | 'queued';
  /** Placed by the forecast for an "Any <model>" job, not pinned by the user. */
  projected?: boolean;
}

/** Where a job is moved to: a printer, or back to any printer of a model. */
export type QueueMoveTarget = { printer_id: number } | { target_model: string };

interface QueueTimelineViewProps {
  queueItems: PrintQueueItem[];
  printers: Printer[];
  printerStatuses: Record<number, { progress?: number; remaining_time?: number; state?: string }>;
  /** `queue_shortest_first`. Dispatch order depends on it, and with it where
   *  every job is forecast to run (#3043), so toggling it refetches. */
  sjfEnabled: boolean;
  onItemClick: (item: PrintQueueItem) => void;
  /** Move a job that has not started. Without it nothing can be dragged. */
  onMoveItem?: (item: PrintQueueItem, target: QueueMoveTarget) => void;
  /** Whether the user may move this job (its owner or queue:update_all). */
  canMoveItem?: (item: PrintQueueItem) => boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function formatHour(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric' });
}

function formatTooltipTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function displayNameOf(item: PrintQueueItem): string {
  return item.archive_name || item.library_file_name || `#${item.id}`;
}

function refusalText(refusal: QueueForecastRefusal, t: QueueTimelineViewProps['t']): string {
  switch (refusal.code) {
    case 'inactive':
    case 'alternatives':
    case 'scope':
    case 'tags':
      return t(`queue.timeline.refusal.${refusal.code}`);
    case 'model':
      return refusal.detail
        ? t('queue.timeline.refusal.model', { model: refusal.detail })
        : t('queue.timeline.refusal.modelUnknown');
    case 'location':
      return t('queue.timeline.refusal.location', { location: refusal.detail ?? '' });
    default:
      return t('queue.timeline.refusal.other');
  }
}

/** A job bar. Draggable when `draggable`; the drag starts after a few pixels
 *  (mouse) or a short press (touch), so a click still opens the job. */
function TimelineBar({
  ev,
  leftPct,
  widthPct,
  draggable,
  dimmed,
  onClick,
  t,
}: {
  ev: ScheduleEvent;
  leftPct: number;
  widthPct: number;
  draggable: boolean;
  dimmed: boolean;
  onClick: () => void;
  t: QueueTimelineViewProps['t'];
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `item-${ev.item.id}`,
    data: { item: ev.item },
    disabled: !draggable,
  });
  const displayName = displayNameOf(ev.item);
  const isPrinting = ev.type === 'printing';
  const tooltipParts = [
    displayName,
    `${formatTooltipTime(ev.estimatedStart)} → ${formatTooltipTime(ev.estimatedEnd)}`,
    ev.item.print_time_seconds ? formatDuration(ev.item.print_time_seconds) : null,
    isPrinting && ev.progress != null ? `${Math.round(ev.progress)}%` : null,
    ev.projected && ev.item.target_model ? `${t('queue.filter.any')} ${ev.item.target_model}` : null,
    ev.item.batch_name ? `batch: ${ev.item.batch_name}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={tooltipParts}
      data-kind={isPrinting ? 'printing' : ev.projected ? 'projected' : 'pinned'}
      className={`absolute rounded-md transition-[filter,opacity] hover:brightness-110 hover:z-10 overflow-hidden flex items-center gap-1.5 px-1.5 text-left ${barClasses(ev)} ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${isDragging || dimmed ? 'opacity-40' : ''}`}
      style={{
        left: `${leftPct}%`,
        width: `max(${MIN_BAR_PX}px, ${widthPct}%)`,
        top: 8,
        height: LANE_BAR_HEIGHT_PX,
      }}
    >
      <BarContent ev={ev} t={t} />
    </button>
  );
}

function barClasses(ev: ScheduleEvent): string {
  if (ev.type === 'printing') return 'bg-blue-500/30 border border-blue-400/60';
  const batched = ev.item.batch_id != null;
  if (ev.projected) {
    return batched
      ? 'bg-cyan-500/10 border border-dashed border-cyan-400/70'
      : 'bg-bambu-green/10 border border-dashed border-bambu-green/70';
  }
  return batched ? 'bg-cyan-500/20 border border-cyan-400/50' : 'bg-bambu-green/20 border border-bambu-green/50';
}

function BarContent({ ev, t }: { ev: ScheduleEvent; t: QueueTimelineViewProps['t'] }) {
  const thumbnailUrl = queueItemThumbnailUrl(ev.item);
  const isPrinting = ev.type === 'printing';
  const second = [
    ev.projected && ev.item.target_model ? `${t('queue.filter.any')} ${ev.item.target_model}` : null,
    ev.item.print_time_seconds ? formatDuration(ev.item.print_time_seconds) : null,
    isPrinting && ev.progress != null ? `${Math.round(ev.progress)}%` : null,
  ].filter(Boolean).join(' · ');
  return (
    <>
      {thumbnailUrl && (
        <img src={thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover shrink-0 bg-bambu-dark" draggable={false} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-white font-medium truncate leading-tight flex items-center gap-1">
          {!isPrinting && (ev.projected
            ? <Shuffle className="w-3 h-3 shrink-0 text-bambu-gray" aria-hidden />
            : <Pin className="w-3 h-3 shrink-0 text-bambu-gray" aria-hidden />)}
          <span className="truncate">{displayNameOf(ev.item)}</span>
        </div>
        <div className="text-[10px] text-bambu-gray truncate leading-tight">{second}</div>
      </div>
      {isPrinting && ev.progress != null && (
        <div className="absolute bottom-0 left-0 h-0.5 bg-blue-300" style={{ width: `${ev.progress}%` }} aria-hidden />
      )}
    </>
  );
}

/** One printer's track: a drop target while a job is dragged. */
function LaneTrack({
  printerId,
  dragState,
  children,
}: {
  printerId: number;
  /** null when nothing is dragged. */
  dragState: { allowed: boolean; current: boolean; reason: string | null; title?: string } | null;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `printer-${printerId}`, data: { printerId } });
  const highlight = dragState && dragState.allowed && !dragState.current
    ? isOver
      ? 'ring-2 ring-inset ring-bambu-green bg-bambu-green/10'
      : 'ring-1 ring-inset ring-bambu-green/40'
    : '';
  return (
    <div
      ref={setNodeRef}
      data-lane={printerId}
      className={`relative flex-1 ${highlight}`}
      style={{ height: LANE_BAR_HEIGHT_PX + 16 }}
    >
      {children}
      {dragState && !dragState.allowed && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-bambu-dark/70 text-xs text-bambu-gray px-2 text-center pointer-events-none"
          title={dragState.title}
          data-testid={`lane-refusal-${printerId}`}
        >
          {dragState.reason}
        </div>
      )}
    </div>
  );
}

function AnyModelDropZone({ label }: { label: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: ANY_MODEL_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 px-3 py-3 border-b border-dashed text-xs ${
        isOver ? 'bg-blue-500/15 border-blue-400 text-white' : 'bg-blue-500/5 border-blue-400/40 text-bambu-gray'
      }`}
    >
      <Undo2 className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
      {label}
    </div>
  );
}

function OffTimelineChip({
  item,
  reason,
  draggable,
  onClick,
}: {
  item: PrintQueueItem;
  reason: string;
  draggable: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `item-${item.id}`,
    data: { item },
    disabled: !draggable,
  });
  const thumbnailUrl = queueItemThumbnailUrl(item);
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={`${displayNameOf(item)} · ${reason}`}
      className={`flex items-center gap-2 max-w-[260px] rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2 py-1 text-left hover:brightness-110 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      {thumbnailUrl && (
        <img src={thumbnailUrl} alt="" className="w-6 h-6 rounded object-cover shrink-0" draggable={false} />
      )}
      <div className="min-w-0">
        <div className="text-xs text-white truncate">{displayNameOf(item)}</div>
        <div className="text-[10px] text-bambu-gray truncate">{reason}</div>
      </div>
    </button>
  );
}

export function QueueTimelineView({
  queueItems,
  printers,
  printerStatuses,
  sjfEnabled,
  onItemClick,
  onMoveItem,
  canMoveItem,
  t,
}: QueueTimelineViewProps) {
  // Tick "now" every minute so the NOW line and ETA labels stay live.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // User can shift the window forward/back in 12h steps. Default = current
  // time, so the timeline reads "next 24h from now."
  const [windowOffsetMs, setWindowOffsetMs] = useState(0);

  // Round the window start down to the previous full hour so the axis ticks
  // land on whole hours.
  const rangeStartMs = useMemo(() => {
    const target = now.getTime() + windowOffsetMs;
    return Math.floor(target / HOUR_MS) * HOUR_MS;
  }, [now, windowOffsetMs]);
  const rangeEndMs = rangeStartMs + RANGE_MS;
  const nowMs = now.getTime();

  // What the forecast depends on, so it is fetched again as soon as the queue
  // changes (a job added, moved, started) rather than at the next poll. Under
  // the 'queue' key, so the page's invalidations after an edit refresh it too.
  const queueSignature = useMemo(
    () => queueItems
      .filter((item) => item.status === 'pending' || item.status === 'printing')
      .map((item) => `${item.id}:${item.status}:${item.printer_id ?? ''}:${item.target_model ?? ''}:${item.position}:${item.scheduled_time ?? ''}:${item.manual_start ? 1 : 0}:${item.waiting_reason ?? ''}`)
      .join('|'),
    [queueItems],
  );
  const { data: forecast, isError: forecastFailed } = useQuery<QueueForecast>({
    queryKey: ['queue', 'forecast', sjfEnabled, queueSignature],
    queryFn: () => api.getQueueForecast(),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const itemsById = useMemo(() => new Map(queueItems.map((item) => [item.id, item])), [queueItems]);
  const printersById = useMemo(() => new Map(printers.map((p) => [p.id, p])), [printers]);
  const lanePrinterState = useMemo(
    () => new Map((forecast?.printers ?? []).map((p) => [p.printer_id, p])),
    [forecast],
  );

  // A move just dropped: drawn faded until the forecast comes back with it.
  const [movingIds, setMovingIds] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    setMovingIds(new Set());
  }, [forecast]);

  const events = useMemo<ScheduleEvent[]>(() => {
    const result: ScheduleEvent[] = [];
    for (const item of queueItems) {
      if (item.status !== 'printing') continue;
      const status = item.printer_id != null ? printerStatuses[item.printer_id] : undefined;
      const start = parseUTCDate(item.started_at) || new Date();
      let endTime: Date;
      if (status?.remaining_time != null && status.remaining_time > 0) {
        endTime = new Date(nowMs + status.remaining_time * 60 * 1000);
      } else if (item.print_time_seconds) {
        const progress = status?.progress || 0;
        const remainingFraction = Math.max(0, 1 - progress / 100);
        endTime = new Date(nowMs + item.print_time_seconds * remainingFraction * 1000);
      } else {
        endTime = new Date(nowMs + HOUR_MS);
      }
      result.push({
        item,
        estimatedStart: start,
        estimatedEnd: endTime,
        progress: status?.progress ?? undefined,
        type: 'printing',
      });
    }
    for (const placement of forecast?.placements ?? []) {
      const item = itemsById.get(placement.item_id);
      if (!item || item.status !== 'pending') continue;
      const start = parseUTCDate(placement.start);
      const end = parseUTCDate(placement.end);
      if (!start || !end) continue;
      result.push({ item, estimatedStart: start, estimatedEnd: end, type: 'queued', projected: placement.projected });
    }
    return result;
  }, [queueItems, printerStatuses, nowMs, forecast, itemsById]);

  const laneOf = (ev: ScheduleEvent): number | null => {
    if (ev.type === 'printing') return ev.item.printer_id;
    return forecast?.placements.find((p) => p.item_id === ev.item.id)?.printer_id ?? null;
  };

  const eventsByPrinter = useMemo(() => {
    const map = new Map<number, ScheduleEvent[]>();
    const placementPrinter = new Map((forecast?.placements ?? []).map((p) => [p.item_id, p.printer_id]));
    for (const ev of events) {
      const printerId = ev.type === 'printing' ? ev.item.printer_id : placementPrinter.get(ev.item.id);
      if (printerId == null) continue;
      if (!map.has(printerId)) map.set(printerId, []);
      map.get(printerId)!.push(ev);
    }
    return map;
  }, [events, forecast]);

  const offTimeline = useMemo(
    () => (forecast?.off_timeline ?? [])
      .map((entry) => ({ entry, item: itemsById.get(entry.item_id) }))
      .filter((row): row is { entry: QueueForecast['off_timeline'][number]; item: PrintQueueItem } =>
        row.item != null && row.item.status === 'pending'),
    [forecast, itemsById],
  );

  const hourTicks = useMemo(() => {
    const ticks: { ms: number; pct: number; label: string }[] = [];
    for (let h = 0; h <= RANGE_HOURS; h += 2) {
      const ms = rangeStartMs + h * HOUR_MS;
      ticks.push({
        ms,
        pct: (h / RANGE_HOURS) * 100,
        label: formatHour(new Date(ms)),
      });
    }
    return ticks;
  }, [rangeStartMs]);

  const nowPct = ((nowMs - rangeStartMs) / RANGE_MS) * 100;
  const nowInView = nowPct >= 0 && nowPct <= 100;

  // Aggregated "all done by" across the entire (un-windowed) event set.
  const allDoneBy = useMemo(() => {
    let latest = 0;
    for (const ev of events) latest = Math.max(latest, ev.estimatedEnd.getTime());
    return latest > 0 ? new Date(latest) : null;
  }, [events]);

  // ── Drag and drop ────────────────────────────────────────────────────────
  const isDraggable = (item: PrintQueueItem): boolean =>
    onMoveItem != null
    && item.status === 'pending'
    && !(item.variants && item.variants.length > 0)
    && (canMoveItem ? canMoveItem(item) : true);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // A short press on touch, so a swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const [dragItem, setDragItem] = useState<PrintQueueItem | null>(null);
  const dragEvent = useMemo(
    () => (dragItem ? events.find((ev) => ev.item.id === dragItem.id) ?? null : null),
    [dragItem, events],
  );
  const dragLane = dragEvent ? laneOf(dragEvent) : dragItem?.printer_id ?? null;
  // Where a pinned job goes back to "Any <model>": its printer's model.
  const unpinModel = dragItem?.printer_id != null ? printersById.get(dragItem.printer_id)?.model ?? null : null;

  const laneDragState = (printerId: number) => {
    if (!dragItem) return null;
    if (printerId === dragLane) return { allowed: true, current: true, reason: null };
    const refusal = forecast?.refusals[String(dragItem.id)]?.[String(printerId)];
    if (refusal) {
      return { allowed: false, current: false, reason: refusalText(refusal, t), title: refusal.detail ?? undefined };
    }
    return { allowed: true, current: false, reason: null };
  };

  const handleDragStart = (event: DragStartEvent) => {
    const item = (event.active.data.current as { item?: PrintQueueItem } | undefined)?.item;
    setDragItem(item ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const item = dragItem;
    setDragItem(null);
    if (!item || !event.over || !onMoveItem) return;
    if (event.over.id === ANY_MODEL_DROP_ID) {
      if (unpinModel) {
        setMovingIds((ids) => new Set(ids).add(item.id));
        onMoveItem(item, { target_model: unpinModel });
      }
      return;
    }
    const printerId = (event.over.data.current as { printerId?: number } | undefined)?.printerId;
    if (printerId == null) return;
    const state = laneDragState(printerId);
    if (!state || !state.allowed || state.current) return;
    setMovingIds((ids) => new Set(ids).add(item.id));
    onMoveItem(item, { printer_id: printerId });
  };

  return (
    <div>
      {/* Window controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowOffsetMs((v) => v - 12 * HOUR_MS)}
            className="p-1.5"
            title={t('queue.timeline.window.back12h')}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-medium text-white min-w-[180px] text-center">
            {new Date(rangeStartMs).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' → '}
            {new Date(rangeEndMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowOffsetMs((v) => v + 12 * HOUR_MS)}
            className="p-1.5"
            title={t('queue.timeline.window.forward12h')}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          {windowOffsetMs !== 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWindowOffsetMs(0)}
              className="text-xs text-bambu-green"
            >
              {t('queue.timeline.window.now')}
            </Button>
          )}
        </div>
        {allDoneBy && (
          <span className="text-xs text-bambu-gray flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {t('queue.timeline.allDoneBy', {
              time: allDoneBy.toLocaleString(undefined, {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </span>
        )}
      </div>

      {/* Legend: what solid, dashed and blue bars mean. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-4 text-xs text-bambu-gray">
        <span className="flex items-center gap-1.5">
          <span className="inline-flex items-center justify-center w-5 h-3.5 rounded-sm bg-bambu-green/20 border border-bambu-green/50" />
          <Pin className="w-3 h-3" aria-hidden />
          {t('queue.timeline.legend.pinned')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-flex w-5 h-3.5 rounded-sm bg-bambu-green/10 border border-dashed border-bambu-green/70" />
          <Shuffle className="w-3 h-3" aria-hidden />
          {t('queue.timeline.legend.projected')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-flex w-5 h-3.5 rounded-sm bg-blue-500/30 border border-blue-400/60" />
          {t('queue.timeline.legend.printing')}
        </span>
        {onMoveItem && <span className="sm:ml-auto italic">{t('queue.timeline.legend.dragHint')}</span>}
      </div>

      {forecastFailed && !forecast && (
        <div className="mb-4 p-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/40 text-xs text-bambu-gray">
          {t('queue.timeline.forecastFailed')}
        </div>
      )}

      {printers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-bambu-gray">
          <Layers className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">{t('queue.timeline.noData')}</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerFirst}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragItem(null)}
        >
          <div className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary overflow-hidden">
          {/* On a phone 24 hours would leave a print a few pixels: the track
              keeps a readable width and scrolls, the printer column stays. */}
          <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            {/* Hour axis */}
            <div className="flex border-b border-bambu-dark-tertiary">
              <div className="w-32 sm:w-40 shrink-0 px-3 py-2 text-xs font-medium text-bambu-gray border-r border-bambu-dark-tertiary sticky left-0 z-30 bg-bambu-dark-secondary">
                {t('queue.timeline.printerColumnHeader')}
              </div>
              <div className="relative flex-1 h-9">
                {hourTicks.map((tick) => (
                  <div
                    key={tick.ms}
                    className="absolute top-0 bottom-0 border-l border-bambu-dark-tertiary/40 text-[10px] sm:text-xs text-bambu-gray pl-1 flex items-center"
                    style={{ left: `${tick.pct}%` }}
                  >
                    {tick.label}
                  </div>
                ))}
              </div>
            </div>

            {dragItem && unpinModel && (
              <AnyModelDropZone label={t('queue.timeline.drop.toAny', { model: unpinModel })} />
            )}

            {/* Lanes */}
            <div className="relative">
              {printers.map((printer) => {
                const laneEvents = eventsByPrinter.get(printer.id) ?? [];
                const live = lanePrinterState.get(printer.id);
                const offline = live != null && !live.connected;
                return (
                  <div key={printer.id} className="flex border-b border-bambu-dark-tertiary/40 last:border-b-0">
                    <div className="w-32 sm:w-40 shrink-0 px-3 py-2 border-r border-bambu-dark-tertiary flex items-center gap-2 min-w-0 sticky left-0 z-30 bg-bambu-dark-secondary">
                      <PrinterIcon className={`w-3.5 h-3.5 shrink-0 ${offline || !printer.is_active ? 'text-bambu-gray' : 'text-bambu-green'}`} />
                      <div className="min-w-0">
                        <div className={`text-sm truncate ${offline || !printer.is_active ? 'text-bambu-gray' : 'text-white'}`}>{printer.name}</div>
                        {(offline || live?.awaiting_plate_clear) && (
                          <div className="text-[10px] text-bambu-gray truncate">
                            {offline ? t('queue.timeline.offline') : t('queue.timeline.plateClear')}
                          </div>
                        )}
                      </div>
                    </div>
                    <LaneTrack printerId={printer.id} dragState={laneDragState(printer.id)}>
                      {/* Hour grid lines */}
                      {hourTicks.map((tick) => (
                        <div
                          key={tick.ms}
                          className="absolute top-0 bottom-0 border-l border-bambu-dark-tertiary/30"
                          style={{ left: `${tick.pct}%` }}
                        />
                      ))}

                      {/* Idle background — diagonal stripes hint that the lane
                          is sittable. Rendered behind bars so they overlay it. */}
                      <div
                        className="absolute inset-0 opacity-30"
                        style={{
                          backgroundImage:
                            'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(255,255,255,0.04) 6px, rgba(255,255,255,0.04) 12px)',
                        }}
                        aria-hidden
                      />

                      {/* A print the printer runs that is not a queue job. */}
                      {live?.external_print && (() => {
                        const endMs = Math.min(rangeEndMs, parseUTCDate(live.free_at)?.getTime() ?? nowMs);
                        const startMs = Math.max(rangeStartMs, nowMs);
                        if (endMs <= startMs) return null;
                        return (
                          <div
                            className="absolute rounded-md bg-bambu-gray/15 border border-bambu-gray/40 px-1.5 flex items-center text-[10px] text-bambu-gray overflow-hidden"
                            style={{
                              left: `${((startMs - rangeStartMs) / RANGE_MS) * 100}%`,
                              width: `max(${MIN_BAR_PX}px, ${((endMs - startMs) / RANGE_MS) * 100}%)`,
                              top: 8,
                              height: LANE_BAR_HEIGHT_PX,
                            }}
                            title={t('queue.timeline.externalPrint')}
                          >
                            <span className="truncate">{t('queue.timeline.externalPrint')}</span>
                          </div>
                        );
                      })()}

                      {/* Job bars */}
                      {laneEvents.map((ev) => {
                        // Clip to the visible window.
                        const startMs = Math.max(rangeStartMs, ev.estimatedStart.getTime());
                        const endMs = Math.min(rangeEndMs, ev.estimatedEnd.getTime());
                        if (endMs <= rangeStartMs || startMs >= rangeEndMs) return null;
                        return (
                          <TimelineBar
                            key={ev.item.id}
                            ev={ev}
                            leftPct={((startMs - rangeStartMs) / RANGE_MS) * 100}
                            widthPct={((endMs - startMs) / RANGE_MS) * 100}
                            draggable={ev.type === 'queued' && isDraggable(ev.item)}
                            dimmed={movingIds.has(ev.item.id)}
                            onClick={() => onItemClick(ev.item)}
                            t={t}
                          />
                        );
                      })}
                    </LaneTrack>
                  </div>
                );
              })}

              {/* NOW line — drawn on top of all lanes. Use the same
                  label-column offset (w-32 sm:w-40) as the lanes so the line
                  aligns exactly with the time track. */}
              {nowInView && (
                <div className="absolute top-0 bottom-0 pointer-events-none z-10 flex inset-x-0">
                  <div className="w-32 sm:w-40 shrink-0" />
                  <div className="relative flex-1">
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]"
                      style={{ left: `${nowPct}%` }}
                    >
                      <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-red-400 rounded-full" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
          </div>

          {/* Pending jobs the forecast does not place, with the reason. */}
          {offTimeline.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-medium text-bambu-gray mb-2">
                {t('queue.timeline.offTimeline.title', { count: offTimeline.length })}
              </div>
              <div className="flex flex-wrap gap-2">
                {offTimeline.map(({ entry, item }) => {
                  const label = t(`queue.timeline.offTimeline.${OFF_TIMELINE_KEYS[entry.reason] ?? 'waiting'}`);
                  const reason = entry.reason === 'waiting' && entry.detail ? entry.detail : label;
                  return (
                    <OffTimelineChip
                      key={item.id}
                      item={item}
                      reason={reason}
                      draggable={isDraggable(item)}
                      onClick={() => onItemClick(item)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          <DragOverlay dropAnimation={null}>
            {dragItem && (
              // Opaque underlay: the bar colours are translucent and the tile
              // passes over other bars.
              <div className="rounded-md bg-bambu-dark-secondary shadow-lg" style={{ width: 200, height: LANE_BAR_HEIGHT_PX }}>
                <div
                  className={`relative h-full rounded-md flex items-center gap-1.5 px-1.5 cursor-grabbing overflow-hidden ${
                    dragEvent ? barClasses(dragEvent) : 'bg-bambu-green/20 border border-bambu-green/50'
                  }`}
                >
                  <BarContent ev={dragEvent ?? { item: dragItem, estimatedStart: now, estimatedEnd: now, type: 'queued' }} t={t} />
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
