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
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, Clock, Layers, Pin, Printer as PrinterIcon, Shuffle } from 'lucide-react';
import { formatDuration, parseUTCDate } from '../utils/date';
import { api } from '../api/client';
import type { PrintQueueItem, Printer, QueueForecast, QueueForecastRefusal } from '../api/client';
import { queueItemThumbnailUrl } from '../utils/queueItemThumbnail';
import { Button } from './Button';
import { QueueJobDetails, type QueuePinTarget } from './QueueJobDetails';

/** Gantt-style 24h-rolling timeline. One horizontal swimlane per printer. A
 *  print that is running is drawn from the printer's live status; every
 *  pending job is drawn where the server's forecast (GET /queue/forecast)
 *  expects the scheduler to run it, including jobs for "Any <model>", which
 *  land on the printer they are expected to get (drawn dashed, as a forecast,
 *  while jobs pinned to a printer are solid). A job that has not started is
 *  dragged to change the queue order: dropped between two jobs, it goes before
 *  the one on the right. Dragging never pins it; a click opens the job's
 *  details, where it is pinned to a printer or handed back to any of its model
 *  (fork). Printers it may not run on (another model, outside its location,
 *  printer tags…), and other printers than its own for a pinned job, refuse
 *  the drop and say why. */

const HOUR_MS = 60 * 60 * 1000;
const RANGE_HOURS = 24;
const RANGE_MS = RANGE_HOURS * HOUR_MS;
// Minimum bar width — short prints (a few minutes) would otherwise render as
// 1-2px slivers and be unclickable. 32px keeps them at thumb size.
const MIN_BAR_PX = 32;
// Lane height for the bar row + label.
const LANE_BAR_HEIGHT_PX = 40;
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
export type QueueMoveTarget = QueuePinTarget;

interface QueueTimelineViewProps {
  queueItems: PrintQueueItem[];
  printers: Printer[];
  printerStatuses: Record<number, { progress?: number; remaining_time?: number; state?: string }>;
  /** `queue_shortest_first`. Dispatch order depends on it, and with it where
   *  every job is forecast to run (#3043), so toggling it refetches. */
  sjfEnabled: boolean;
  /** Put a job just before (or, at the end of a lane, just after) another in
   *  the queue order. Without it, or without `canReorder`, nothing is dragged.
   *  Returns false when the job was dropped where it already was. */
  onReorder?: (itemId: number, anchorId: number, placeAfter: boolean) => boolean;
  /** Manual order applies: queue:reorder and shortest-first off. */
  canReorder?: boolean;
  /** Pin a job to a printer, or hand it back to any printer of a model. */
  onPinItem?: (item: PrintQueueItem, target: QueueMoveTarget) => void;
  /** Whether the user may change this job (its owner or queue:update_all). */
  canModifyItem?: (item: PrintQueueItem) => boolean;
  onEditItem?: (item: PrintQueueItem) => void;
  onCancelItem?: (item: PrintQueueItem) => void;
  onStopItem?: (item: PrintQueueItem) => void;
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
      data-bar-item={ev.item.id}
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
  markerX,
  children,
}: {
  printerId: number;
  /** null when nothing is dragged. */
  dragState: { allowed: boolean; reason: string | null; title?: string } | null;
  /** Where the dragged job would be inserted, in px from the track's left. */
  markerX: number | null;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `printer-${printerId}`, data: { printerId } });
  const highlight = dragState && dragState.allowed
    ? isOver
      ? 'bg-bambu-green/5'
      : 'ring-1 ring-inset ring-bambu-green/30'
    : '';
  return (
    <div
      ref={setNodeRef}
      data-lane={printerId}
      className={`relative flex-1 ${highlight}`}
      style={{ height: LANE_BAR_HEIGHT_PX + 16 }}
    >
      {children}
      {markerX != null && (
        // The gap the job drops into: it goes before the job on the right.
        <div
          className="absolute top-1 bottom-1 z-20 w-1 -ml-0.5 rounded-full bg-bambu-green shadow-[0_0_10px_rgba(0,174,66,0.8)] pointer-events-none"
          style={{ left: markerX }}
          data-testid={`drop-marker-${printerId}`}
          aria-hidden
        >
          <div className="absolute -top-1 -left-1 w-3 h-3 rotate-45 bg-bambu-green" />
          <div className="absolute -bottom-1 -left-1 w-3 h-3 rotate-45 bg-bambu-green" />
        </div>
      )}
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
  onReorder,
  canReorder = true,
  onPinItem,
  canModifyItem,
  onEditItem,
  onCancelItem,
  onStopItem,
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

  // ── Drag and drop: the queue order ─────────────────────────────────────────
  const mayModify = (item: PrintQueueItem): boolean => (canModifyItem ? canModifyItem(item) : true);
  const isDraggable = (item: PrintQueueItem): boolean =>
    onReorder != null
    && canReorder
    && item.status === 'pending'
    && !(item.variants && item.variants.length > 0)
    && mayModify(item);

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
  // The gap the dragged job would drop into.
  const [dropTarget, setDropTarget] = useState<{
    printerId: number;
    x: number;
    anchorId: number | null;
    placeAfter: boolean;
  } | null>(null);

  const laneDragState = (printerId: number) => {
    if (!dragItem) return null;
    if (dragItem.printer_id != null) {
      // Dragging changes the order, not the printer: a pinned job stays on its
      // own lane. Moving it is a choice made in its details.
      return dragItem.printer_id === printerId
        ? { allowed: true, reason: null }
        : {
            allowed: false,
            reason: t('queue.timeline.drop.pinnedElsewhere', {
              printer: printersById.get(dragItem.printer_id)?.name ?? `#${dragItem.printer_id}`,
            }),
          };
    }
    const refusal = forecast?.refusals[String(dragItem.id)]?.[String(printerId)];
    if (refusal) {
      return { allowed: false, reason: refusalText(refusal, t), title: refusal.detail ?? undefined };
    }
    return { allowed: true, reason: null };
  };

  // Where the pointer (or finger) is now: where the drag started plus how far it went.
  const pointerX = (event: DragMoveEvent | DragOverEvent | DragEndEvent): number | null => {
    const start = event.activatorEvent as MouseEvent | TouchEvent | null;
    if (!start) return null;
    const point = 'touches' in start ? start.touches[0] ?? start.changedTouches[0] : start;
    return point ? point.clientX + event.delta.x : null;
  };

  // The queued jobs on a lane, as drawn, without the one being dragged: the
  // gap under the pointer is before the first whose middle is right of it.
  const gapAt = (printerId: number, x: number, draggedId: number) => {
    const lane = document.querySelector<HTMLElement>(`[data-lane="${printerId}"]`);
    if (!lane) return null;
    const laneLeft = lane.getBoundingClientRect().left;
    const bars = Array.from(lane.querySelectorAll<HTMLElement>('[data-bar-item]'))
      .filter((el) => el.dataset.kind !== 'printing' && Number(el.dataset.barItem) !== draggedId)
      .map((el) => ({ id: Number(el.dataset.barItem), rect: el.getBoundingClientRect() }))
      .sort((a, b) => a.rect.left - b.rect.left);
    const index = bars.findIndex((bar) => x < bar.rect.left + bar.rect.width / 2);
    if (bars.length === 0) return { printerId, x: 0, anchorId: null, placeAfter: false };
    if (index === -1) {
      const last = bars[bars.length - 1];
      return { printerId, x: last.rect.right - laneLeft, anchorId: last.id, placeAfter: true };
    }
    return { printerId, x: bars[index].rect.left - laneLeft, anchorId: bars[index].id, placeAfter: false };
  };

  const handleDragStart = (event: DragStartEvent) => {
    const item = (event.active.data.current as { item?: PrintQueueItem } | undefined)?.item;
    setDragItem(item ?? null);
    setDropTarget(null);
  };

  // The gap under the pointer on the lane it is over, if the job may go there.
  const gapFor = (event: DragMoveEvent | DragOverEvent | DragEndEvent) => {
    const printerId = (event.over?.data.current as { printerId?: number } | undefined)?.printerId;
    const x = pointerX(event);
    if (!dragItem || printerId == null || x == null || !laneDragState(printerId)?.allowed) return null;
    return gapAt(printerId, x, dragItem.id);
  };

  // On every move, and when the lane under the pointer changes: a move event
  // can still carry the lane it was over a moment ago.
  const handleDragMove = (event: DragMoveEvent | DragOverEvent) => {
    const gap = gapFor(event);
    setDropTarget((prev) =>
      prev && gap && prev.printerId === gap.printerId && prev.anchorId === gap.anchorId && prev.placeAfter === gap.placeAfter
        ? prev
        : gap,
    );
  };

  // The job whose details are open, and a printer to offer for pinning.
  const [details, setDetails] = useState<{ itemId: number; suggestedPrinterId?: number } | null>(null);

  const handleDragEnd = (event: DragEndEvent) => {
    const item = dragItem;
    const target = gapFor(event);
    setDragItem(null);
    setDropTarget(null);
    if (!item || !target || !onReorder) return;
    if (target.anchorId != null) {
      if (onReorder(item.id, target.anchorId, target.placeAfter)) {
        setMovingIds((ids) => new Set(ids).add(item.id));
      }
    } else if (item.printer_id == null) {
      // An empty lane has no order to join: the way to put a job there is to
      // pin it, so its details open with that printer offered.
      setDetails({ itemId: item.id, suggestedPrinterId: target.printerId });
    }
  };

  // ── The open job's details ────────────────────────────────────────────────
  const detailsItem = details ? itemsById.get(details.itemId) ?? null : null;
  const detailsEvent = detailsItem ? events.find((ev) => ev.item.id === detailsItem.id) ?? null : null;
  const detailsLane = detailsItem
    ? detailsItem.status === 'printing'
      ? detailsItem.printer_id
      : forecast?.placements.find((p) => p.item_id === detailsItem.id)?.printer_id ?? null
    : null;
  const detailsExpected = detailsEvent && detailsLane != null
    ? { printerId: detailsLane, start: detailsEvent.estimatedStart, end: detailsEvent.estimatedEnd }
    : null;
  const detailsOff = detailsItem ? offTimeline.find((row) => row.item.id === detailsItem.id)?.entry : undefined;
  const detailsHeld = detailsOff
    ? detailsOff.reason === 'waiting' && detailsOff.detail
      ? detailsOff.detail
      : t(`queue.timeline.offTimeline.${OFF_TIMELINE_KEYS[detailsOff.reason] ?? 'waiting'}`)
    : null;
  const detailsPinChoices = detailsItem
    ? printers.filter(
        (p) =>
          p.is_active
          && p.id !== detailsItem.printer_id
          && !forecast?.refusals[String(detailsItem.id)]?.[String(p.id)],
      )
    : [];
  // A job that went away (started elsewhere, removed) closes its details.
  useEffect(() => {
    if (details && !detailsItem) setDetails(null);
  }, [details, detailsItem]);

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
        {onReorder && (
          <span className="sm:ml-auto italic">
            {canReorder ? t('queue.timeline.legend.dragHint') : t('queue.timeline.legend.sjfHint')}
          </span>
        )}
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
          onDragMove={handleDragMove}
          onDragOver={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setDragItem(null);
            setDropTarget(null);
          }}
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
                    <LaneTrack
                      printerId={printer.id}
                      dragState={laneDragState(printer.id)}
                      markerX={dropTarget?.printerId === printer.id ? dropTarget.x : null}
                    >
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
                            onClick={() => setDetails({ itemId: ev.item.id })}
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
                      onClick={() => setDetails({ itemId: item.id })}
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

      {detailsItem && (
        <QueueJobDetails
          item={detailsItem}
          printers={printers}
          expected={detailsExpected}
          progress={detailsItem.status === 'printing' ? detailsEvent?.progress ?? null : null}
          heldReason={detailsHeld}
          pinChoices={detailsPinChoices}
          suggestedPrinterId={details?.suggestedPrinterId ?? null}
          canModify={mayModify(detailsItem)}
          onPin={onPinItem ? (target) => {
            setMovingIds((ids) => new Set(ids).add(detailsItem.id));
            onPinItem(detailsItem, target);
            setDetails(null);
          } : undefined}
          onEdit={onEditItem ? () => { setDetails(null); onEditItem(detailsItem); } : undefined}
          onCancel={onCancelItem ? () => { setDetails(null); onCancelItem(detailsItem); } : undefined}
          onStop={onStopItem ? () => { setDetails(null); onStopItem(detailsItem); } : undefined}
          onClose={() => setDetails(null)}
          t={t}
        />
      )}
    </div>
  );
}
