import { createContext, useContext, useState, useMemo, useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
  type Announcements,
} from '@dnd-kit/core';
import {
  AlertTriangle,
  Bookmark,
  BookmarkX,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Hand,
  HelpCircle,
  Layers,
  Loader2,
  Lock,
  Moon,
  Move,
  PencilRuler,
  Pin,
  Printer as PrinterIcon,
  RefreshCw,
  Shuffle,
  Undo2,
  UserX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { formatDuration, parseUTCDate } from '../utils/date';
import { AWAY_STRIPES } from '../utils/staffedMarks';
import { api } from '../api/client';
import type {
  PrintQueueItem,
  Printer,
  QueueForecast,
  QueueForecastPlateWait,
  QueueForecastRefusal,
  QueueForecastVariant,
  QueuePlan,
  QueuePlanResult,
} from '../api/client';
import { queueJobModels, queueJobName, queueJobPrintTime, queueJobThumbnailUrl } from '../utils/queueJobDisplay';
import { Button } from './Button';
import { QueueJobDetails, type QueuePinTarget } from './QueueJobDetails';
import {
  planIsStale,
  rebasePlan,
  reservationState,
  zoomForTrackWidth,
  ZOOM_HOURS,
  type PlanLanes,
  type QueueHoldKind,
} from '../utils/queueTimelinePlan';
import { StaffedHoursDialog } from './StaffedHoursDialog';
import { useJobOrders } from '../hooks/useJobOrders';
import { jobOrdersText, urgentFirst } from '../utils/baseOrders';
import { fitBarHeight, LANE_BAR_HEIGHT_PX, LANE_PADDING_PX } from '../utils/timelineLayout';
import { queueHold } from '../utils/queueHold';
import { translateWaitingReason } from '../utils/serverMessages';
import { withColorSquares } from '../utils/colorSquares';

/** Gantt-style rolling timeline. One horizontal swimlane per printer. A
 *  print that is running is drawn from the printer's live status; every
 *  pending job is drawn where the server's forecast (GET /queue/forecast)
 *  expects the scheduler to run it, including jobs for "Any <model>", which
 *  land on the printer they are expected to get (drawn dashed, as a forecast,
 *  while jobs pinned to a printer are solid) (fork).
 *
 *  Dragging a job that has not started lays out a plan, saved nowhere until
 *  it is applied: the job goes into the gap it is dropped in, on its own lane
 *  or another printer's, the jobs after it on that lane move along, and
 *  nothing else moves. Applying the plan (POST /queue/plan) holds each moved
 *  "Any" job for the printer it was put on and orders the queue as laid out.
 *  A pinned job stays on its lane; printers an "Any" job may not wait for
 *  (another model, outside its location, printer tags, offline…) refuse the
 *  drop and say why. A click opens the job's details, where it is pinned to a
 *  printer, handed back to any of its model or released from its printer. */

const HOUR_MS = 60 * 60 * 1000;
// The printer column and the page around the track, for a guess before it is measured.
const TRACK_CHROME_PX = 260;
function defaultZoom(): number {
  const width = typeof window !== 'undefined' ? window.innerWidth : 1440;
  return zoomForTrackWidth(width - TRACK_CHROME_PX);
}
const ZOOM_STORAGE_KEY = 'queueTimelineZoomHours';
// Fork: the legend and the hints, shown or folded away; remembered.
const HELP_STORAGE_KEY = 'queueTimelineHelpOpen';
function storedHelpOpen(): boolean {
  try {
    const stored = localStorage.getItem(HELP_STORAGE_KEY);
    if (stored === '1' || stored === '0') return stored === '1';
  } catch {
    // Private mode: the default below.
  }
  // Folded on a short or narrow window, where the lanes need the room.
  return typeof window !== 'undefined' && window.innerWidth >= 1024 && window.innerHeight >= 900;
}
// Hours between axis ticks at each zoom: about six to twelve labels.
function tickStepHours(rangeHours: number): number {
  if (rangeHours <= 4) return 0.5;
  if (rangeHours <= 12) return 1;
  if (rangeHours <= 24) return 2;
  if (rangeHours <= 48) return 4;
  return 6;
}
/** The zoom someone chose before, or null. */
function storedZoom(): number | null {
  try {
    const index = ZOOM_HOURS.indexOf(Number(localStorage.getItem(ZOOM_STORAGE_KEY)));
    return index === -1 ? null : index;
  } catch {
    return null;
  }
}
// Trackpad pinch arrives as ctrl+wheel in small steps: this much makes one zoom step.
const WHEEL_ZOOM_STEP = 40;
// A two-finger pinch zooms a step each time the fingers spread or close this much.
const PINCH_ZOOM_RATIO = 1.3;
// A drag that ends this close to where it began was a long tap: it opens the job.
const TAP_SLOP_PX = 10;
// Minimum bar width — short prints (a few minutes) would otherwise render as
// 1-2px slivers and be unclickable. 32px keeps them at thumb size.
const MIN_BAR_PX = 32;
// Kept free under the lanes: the page's padding, a scrollbar.
const LANES_BOTTOM_RESERVE_PX = 40;
// The jobs off the lanes, when there are any.
const OFF_TIMELINE_RESERVE_PX = 72;
// Fork: the bar height of this timeline, from the room the screen has.
const BarHeightContext = createContext(LANE_BAR_HEIGHT_PX);
// The picture on a tall bar: at most this big, and this share of the bar's width.
const THUMB_MAX_PX = 80;
const THUMB_SHARE_CQW = 24;
const THUMB_LARGE_MAX_PX = 112;

/** A job's name on its bar: the slicer's file extension is room the bar needs for the rest. */
function barName(name: string): string {
  return name.replace(/(\.gcode)?\.3mf$|\.gcode$/i, '');
}
// Why a finished plate waits until then (GET /queue/forecast plate_waits).
type PlateWaitReason = NonNullable<QueueForecastPlateWait['reason']>;
interface PlateWaitSpan {
  start: number;
  end: number;
  reason: PlateWaitReason;
}
// A printer standing with a finished plate: hatched, behind the bars.
const PLATE_WAIT_PATTERN =
  'repeating-linear-gradient(-45deg, transparent, transparent 4px, rgba(156,163,175,0.18) 4px, rgba(156,163,175,0.18) 6px)';
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
  /** For a job with alternatives: the one its printer takes. */
  variant?: QueueForecastVariant | null;
  /** An "Any" job held for a printer (fork): firm, the planner's soft choice, or a soft choice that gave way. */
  hold?: QueueHoldKind | null;
  /** Moved in the plan being laid out, not applied yet. */
  moved?: boolean;
}

/** The plan being laid out: each printer's queued jobs in order, the jobs
 *  moved, and the forecast's lanes it was laid out on (to tell when the queue
 *  changed under it, and which lanes the user changed). */
interface Draft {
  lanes: PlanLanes;
  moved: number[];
  base: PlanLanes;
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
  /** Apply the plan laid out on the lanes. Without it, or without
   *  `canReorder`, nothing is dragged. Rejects when it was not applied. */
  onApplyPlan?: (plan: QueuePlan) => Promise<QueuePlanResult>;
  /** Manual order applies: the right to reorder the queue and shortest-first off. */
  canReorder?: boolean;
  /** Hand a job the plan reserved back to any printer of its model. */
  onReleaseReservation?: (item: PrintQueueItem) => void;
  /** May change when someone is there to clear plates (settings:update). */
  canEditStaffedHours?: boolean;
  /** Fork: plan every product's open orders again; the caller asks first. Hidden when absent. */
  onReplanQueue?: () => void;
  replanning?: boolean;
  /** Pin a job to a printer, or hand it back to any printer of a model. */
  onPinItem?: (item: PrintQueueItem, target: QueueMoveTarget) => void;
  /** Whether the user may change this job (its owner or queue:update_all). */
  canModifyItem?: (item: PrintQueueItem) => boolean;
  onEditItem?: (item: PrintQueueItem) => void;
  onCancelItem?: (item: PrintQueueItem) => void;
  onStopItem?: (item: PrintQueueItem) => void;
  /** Fork: press Start on a job waiting for it (manual start). */
  onStartItem?: (item: PrintQueueItem) => void;
  /** Fork: a job to open the details of (a link from the Products page); done is called once handled. */
  focusItemId?: number | null;
  onFocusItemDone?: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

// Fork: times in the app's language, not the device's ("15", not "3 PM", in a Polish UI).
function formatHour(date: Date, language: string): string {
  return date.toLocaleTimeString(language, { hour: 'numeric' });
}

function formatTooltipTime(date: Date, language: string): string {
  return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
}

/** A printer model for comparing: "P1S", "p1s" and "P1-S" are one. */
function modelKey(model: string | null | undefined): string {
  return (model ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** "Any P1S" for the bar: the model of the alternative its printer takes, if any. */
function anyModelLabel(ev: ScheduleEvent, t: QueueTimelineViewProps['t']): string | null {
  if (!ev.projected) return null;
  const model = ev.variant?.target_model ?? ev.item.target_model;
  return model ? `${t('queue.filter.any')} ${model}` : null;
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
    case 'offline':
      return t('queue.timeline.refusal.offline');
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
  const { i18n } = useTranslation();
  const barHeight = useContext(BarHeightContext);
  const displayName = queueJobName(ev.item, ev.variant);
  const isPrinting = ev.type === 'printing';
  const hold = isPrinting ? null : queueHold(ev.item, t);
  const printTime = queueJobPrintTime(ev.item, ev.variant);
  const models = queueJobModels(ev.item);
  // Fork (products): the order(s) a product job prints for.
  const { data: jobOrders } = useJobOrders();
  const orders = jobOrders?.items[String(ev.item.id)];
  const orderText = jobOrdersText(orders, t('products.orderLabel.forStock'));
  // A desktop's hover summary; all of it is also in the job's details, which a tap opens.
  const tooltipParts = [
    displayName,
    urgentFirst(orders).length
      ? t('products.orderLabel.forTooltip', {
          // A hand order's title is empty when it would repeat the label: no empty brackets then.
          list: urgentFirst(orders)
            .map((o) => (o.title ? `${o.label} (${o.title})` : o.label))
            .join(', '),
        })
      : null,
    `${formatTooltipTime(ev.estimatedStart, i18n.language)} → ${formatTooltipTime(ev.estimatedEnd, i18n.language)}`,
    printTime ? formatDuration(printTime) : null,
    isPrinting && ev.progress != null ? `${Math.round(ev.progress)}%` : null,
    ev.projected && models.length > 0 ? `${t('queue.filter.any')} ${models.join(' / ')}` : null,
    ev.item.batch_name ? `${t('queue.timeline.details.batch')}: ${ev.item.batch_name}` : null,
    // Placed from when someone is expected to be there to press Start; held
    // by a problem (fork), it says which and that it will not start by itself.
    hold?.problem
      ? `${hold.text} — ${t('queue.hold.wontStart')}`
      : !isPrinting && ev.item.manual_start
        ? [t('queue.timeline.manualStartHelp'), translateWaitingReason(ev.item.waiting_reason, t)].filter(Boolean).join(': ')
        : null,
  ].filter(Boolean).join(' · ');
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={tooltipParts}
      data-bar-item={ev.item.id}
      data-kind={isPrinting ? 'printing' : ev.hold === 'firm' ? 'reserved' : ev.hold === 'soft' ? 'planner' : ev.projected ? 'projected' : 'pinned'}
      data-reservation={ev.hold ?? undefined}
      data-moved={ev.moved ? 'true' : undefined}
      data-manual={!isPrinting && ev.item.manual_start ? 'true' : undefined}
      data-hold={hold?.problem ? 'problem' : undefined}
      className={`@container absolute rounded-md transition-[filter,opacity] hover:brightness-110 hover:z-10 overflow-hidden flex items-center gap-1.5 px-1.5 text-left ${barClasses(ev)} ${
        // Moved in the open plan: a white dashed outline, unlike any hold's border.
        ev.moved ? 'outline-2 outline-dashed outline-white/80 outline-offset-1' : ''
      } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${isDragging || dimmed ? 'opacity-40' : ''}`}
      style={{
        left: `${leftPct}%`,
        width: `max(${MIN_BAR_PX}px, ${widthPct}%)`,
        top: LANE_PADDING_PX / 2,
        height: barHeight,
      }}
    >
      <BarContent ev={ev} t={t} orderText={orderText} height={barHeight} />
    </button>
  );
}

function barClasses(ev: ScheduleEvent): string {
  if (ev.type === 'printing') return 'bg-blue-500/30 border border-blue-400/60';
  // Fork: held by a problem (the spool is short, a filament is not loaded):
  // it will not start by itself, whatever its lane says.
  if (ev.item.status === 'pending' && ev.item.manual_start && (ev.item.filament_short || ev.item.waiting_reason)) {
    return 'bg-red-500/15 border-2 border-red-400/80';
  }
  // Waits for its printer: solid amber. The planner's choice that may give
  // way: dashed amber. One that gave way is drawn as the forecast placed it.
  if (ev.hold === 'firm') return 'bg-amber-500/15 border border-amber-400/60';
  if (ev.hold === 'soft') return 'bg-amber-500/10 border border-dashed border-amber-400/70';
  const batched = ev.item.batch_id != null;
  if (ev.projected) {
    return batched
      ? 'bg-cyan-500/10 border border-dashed border-cyan-400/70'
      : 'bg-bambu-green/10 border border-dashed border-bambu-green/70';
  }
  return batched ? 'bg-cyan-500/20 border border-cyan-400/50' : 'bg-bambu-green/20 border border-bambu-green/50';
}

/** The icons before a bar's name (fork): why it waits (a problem, a manual
 *  start) and how it is tied to its printer, together, so neither is told by
 *  colour alone. */
function BarIcons({ ev, problem, manual }: { ev: ScheduleEvent; problem: boolean; manual: boolean }) {
  const icon = 'w-3 h-3 shrink-0 mt-0.5';
  const icons: ReactNode[] = [];
  if (problem) icons.push(<AlertTriangle key="problem" className={`${icon} text-red-300`} aria-hidden data-icon="problem" />);
  else if (manual) icons.push(<Hand key="manual" className={`${icon} text-bambu-gray`} aria-hidden data-icon="manual" />);
  if (ev.hold === 'firm') icons.push(<Lock key="hold" className={`${icon} text-amber-300`} aria-hidden data-icon="firm" />);
  else if (ev.hold === 'soft') icons.push(<Bookmark key="hold" className={`${icon} text-amber-300`} aria-hidden data-icon="soft" />);
  else if (ev.hold === 'gaveWay') icons.push(<BookmarkX key="hold" className={`${icon} text-bambu-gray`} aria-hidden data-icon="gaveWay" />);
  else if (!problem && !manual) {
    icons.push(ev.projected
      ? <Shuffle key="where" className={`${icon} text-bambu-gray`} aria-hidden data-icon="projected" />
      : <Pin key="where" className={`${icon} text-bambu-gray`} aria-hidden data-icon="pinned" />);
  }
  if (ev.moved) icons.push(<Move key="moved" className={`${icon} text-white`} aria-hidden data-icon="moved" />);
  return <>{icons}</>;
}

/**
 * What a bar shows. Fork: as much as its size allows. Its height (the lanes
 * grow to fill the screen) adds lines: the orders, the time it runs, the
 * rest; its width (a container query on the bar) drops the picture and the
 * extra lines of a short job.
 */
function BarContent({
  ev,
  t,
  orderText = null,
  height = LANE_BAR_HEIGHT_PX,
}: {
  ev: ScheduleEvent;
  t: QueueTimelineViewProps['t'];
  orderText?: string | null;
  height?: number;
}) {
  const { i18n } = useTranslation();
  const thumbnailUrl = queueJobThumbnailUrl(ev.item, ev.variant);
  const isPrinting = ev.type === 'printing';
  const printTime = queueJobPrintTime(ev.item, ev.variant);
  const manual = !isPrinting && ev.item.manual_start;
  const hold = isPrinting ? null : queueHold(ev.item, t);
  const manualText = hold?.problem ? hold.text : manual ? t('queue.timeline.manualStart') : null;
  // Lines by what fits (a name line ~15px, the small ones ~14px): from 64px
  // the orders and the hours get lines of their own, from 76px the name two
  // lines, from 92px one more line of details, from 108px a third name line
  // and the hours and the print time each a line, from 136px a larger text.
  const tall = height >= 64;
  const roomy = height >= 92;
  const spacious = height >= 108;
  // A tall screen's bars: a bigger picture and details a size up.
  const large = height >= 136;
  const progress = isPrinting && ev.progress != null ? `${Math.round(ev.progress)}%` : null;
  const when = `${formatTooltipTime(ev.estimatedStart, i18n.language)}–${formatTooltipTime(ev.estimatedEnd, i18n.language)}`;
  const second = [
    hold?.problem ? hold.text : null,
    orderText,
    !hold?.problem && manual ? t('queue.timeline.manualStart') : null,
    anyModelLabel(ev, t),
    printTime ? formatDuration(printTime) : null,
    progress,
  ].filter(Boolean).join(' · ');
  const length = [printTime ? formatDuration(printTime) : null, progress].filter(Boolean).join(' · ');
  const timing = [when, length || null].filter(Boolean).join(' · ');
  const grams = ev.item.filament_used_grams;
  const filament = [ev.item.filament_type, grams ? `${Math.round(grams)} g` : null].filter(Boolean).join(' ');
  const more = [filament || null, hold?.problem ? null : manualText, anyModelLabel(ev, t), ev.item.batch_name]
    .filter(Boolean)
    .join(' · ');
  const filamentColor = ev.item.filament_color ? `#${ev.item.filament_color.replace('#', '').slice(0, 6)}` : null;
  // The text goes first: the picture takes at most a quarter of the bar's
  // width (cqw: the bar is a size container), at most the bar's height and
  // THUMB_MAX_PX, and a bar too narrow for both shows the text alone.
  const thumbMax = tall ? Math.min(height - 12, large ? THUMB_LARGE_MAX_PX : THUMB_MAX_PX) : 28;
  // A narrow bar has no room for the details line: the name takes it.
  const nameLines =
    large
      ? 'line-clamp-4 break-words'
      : spacious
        ? 'line-clamp-3 break-words'
        : height >= 92
          ? 'line-clamp-2 @max-[9rem]:line-clamp-3 break-words'
          : height >= 76 || (!tall && height >= 48)
            ? 'line-clamp-2 break-words'
            : 'truncate';
  const small = large ? 'text-[13px]' : spacious ? 'text-[11px]' : 'text-[10px]';
  const medium = large ? 'text-sm' : 'text-[11px]';
  return (
    <>
      {thumbnailUrl && (
        <img
          src={thumbnailUrl}
          alt=""
          className={`rounded object-cover shrink-0 bg-bambu-dark aspect-square ${
            tall ? 'hidden @min-[8rem]:block' : 'hidden @min-[5rem]:block'
          }`}
          style={{ width: `min(${thumbMax}px, ${THUMB_SHARE_CQW}cqw)` }}
          draggable={false}
        />
      )}
      <div className="min-w-0 flex-1">
        <div
          className={`text-white font-medium leading-tight flex gap-1 ${
            large ? 'text-[15px] items-start' : tall ? 'text-xs items-start @min-[15rem]:text-sm' : `text-xs ${height >= 48 ? 'items-start' : 'items-center'}`
          }`}
        >
          {!isPrinting && <BarIcons ev={ev} problem={!!hold?.problem} manual={manual} />}
          <span className={nameLines}>{barName(queueJobName(ev.item, ev.variant))}</span>
        </div>
        {tall ? (
          <>
            {hold?.problem && (
              <div className={`${medium} text-red-200 font-medium truncate leading-tight mt-0.5`} data-bar-line="hold">
                {withColorSquares(hold.text)}
              </div>
            )}
            {orderText && (
              <div className={`${medium} text-white/80 truncate leading-tight mt-0.5`} data-bar-line="orders">
                {orderText}
              </div>
            )}
            {spacious ? (
              // Room enough: the hours and the print time each a line, so neither is cut.
              <>
                <div className={`${small} text-bambu-gray truncate leading-tight mt-0.5`} data-bar-line="timing">
                  {when}
                </div>
                {length && (
                  <div className={`${small} text-bambu-gray truncate leading-tight mt-0.5`} data-bar-line="length">
                    {length}
                  </div>
                )}
              </>
            ) : (
              <div className={`${small} text-bambu-gray truncate leading-tight mt-0.5`} data-bar-line="timing">
                {timing}
              </div>
            )}
            {roomy && more && (
              <div
                className={`hidden @min-[9rem]:flex items-center gap-1 ${small} text-bambu-gray leading-tight mt-0.5 min-w-0`}
                data-bar-line="more"
              >
                {filament && filamentColor && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0 ring-1 ring-white/20"
                    style={{ backgroundColor: filamentColor }}
                    aria-hidden
                  />
                )}
                <span className={spacious ? 'line-clamp-2 break-words' : 'truncate'}>{more}</span>
              </div>
            )}
          </>
        ) : (
          <div className="text-[10px] text-bambu-gray truncate leading-tight">{second}</div>
        )}
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
  const barHeight = useContext(BarHeightContext);
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
      style={{ height: barHeight + LANE_PADDING_PX }}
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
  problem = false,
  draggable,
  onClick,
}: {
  item: PrintQueueItem;
  reason: string;
  /** Fork: held by a problem (the spool is short, a filament is not loaded). */
  problem?: boolean;
  draggable: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `item-${item.id}`,
    data: { item },
    disabled: !draggable,
  });
  const thumbnailUrl = queueJobThumbnailUrl(item);
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={`${queueJobName(item)} · ${reason}`}
      data-hold={problem ? 'problem' : undefined}
      className={`flex items-center gap-2 max-w-[260px] rounded-md border px-2 py-1 text-left hover:brightness-110 ${
        problem ? 'border-red-400/70 bg-red-500/10' : 'border-bambu-dark-tertiary bg-bambu-dark/60'
      } ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      {thumbnailUrl && (
        <img src={thumbnailUrl} alt="" className="w-6 h-6 rounded object-cover shrink-0" draggable={false} />
      )}
      {problem && <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-400" aria-hidden />}
      <div className="min-w-0">
        <div className="text-xs text-white truncate">{queueJobName(item)}</div>
        <div className={`text-[10px] truncate ${problem ? 'text-red-300' : 'text-bambu-gray'}`}>{withColorSquares(reason)}</div>
      </div>
    </button>
  );
}

export function QueueTimelineView({
  queueItems,
  printers,
  printerStatuses,
  sjfEnabled,
  onApplyPlan,
  canReorder = true,
  onReleaseReservation,
  canEditStaffedHours = false,
  onReplanQueue,
  replanning = false,
  onPinItem,
  canModifyItem,
  onEditItem,
  onCancelItem,
  onStopItem,
  onStartItem,
  focusItemId = null,
  onFocusItemDone,
  t,
}: QueueTimelineViewProps) {
  const { i18n } = useTranslation();
  const language = i18n.language;
  // Tick "now" every minute so the NOW line and ETA labels stay live.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // User can shift the window forward/back by half its width. Default =
  // current time, so the timeline reads "next 24h from now."
  const [windowOffsetMs, setWindowOffsetMs] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(() => storedZoom() ?? defaultZoom());
  const rangeHours = ZOOM_HOURS[zoomIndex];
  const rangeMs = rangeHours * HOUR_MS;
  const stepHours = tickStepHours(rangeHours);
  // Remembered once someone zooms (fork): until then the default follows the
  // track's measured width.
  const zoomChosen = useRef(storedZoom() != null);
  useEffect(() => {
    if (!zoomChosen.current) return;
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(rangeHours));
    } catch {
      // Private mode: the zoom is just not remembered.
    }
  }, [rangeHours]);

  // Round the window start down to the previous full hour (half hour when
  // zoomed in closest) so the axis ticks land on whole hours.
  const rangeStartMs = useMemo(() => {
    const target = now.getTime() + windowOffsetMs;
    const align = Math.min(stepHours, 1) * HOUR_MS;
    return Math.floor(target / align) * align;
  }, [now, windowOffsetMs, stepHours]);
  const rangeEndMs = rangeStartMs + rangeMs;
  const nowMs = now.getTime();

  // Zoom one step in (-1) or out (+1). With a point to hold (the pointer, the
  // middle of a pinch) the time under it stays put; else the window's start does.
  const axisRef = useRef<HTMLDivElement>(null);
  const zoomBy = (direction: -1 | 1, clientX?: number) => {
    const next = Math.min(ZOOM_HOURS.length - 1, Math.max(0, zoomIndex + direction));
    if (next === zoomIndex) return;
    zoomChosen.current = true;
    const rect = axisRef.current?.getBoundingClientRect();
    if (clientX != null && rect && rect.width > 0) {
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const heldMs = rangeStartMs + fraction * rangeMs;
      const nextStart = heldMs - fraction * ZOOM_HOURS[next] * HOUR_MS;
      const offset = nextStart - nowMs;
      // Close to now counts as now, so "Now" does not appear for a rounding.
      setWindowOffsetMs(Math.abs(offset) < HOUR_MS / 2 ? 0 : offset);
    }
    setZoomIndex(next);
  };
  // The listeners below are attached once; they call the latest zoomBy.
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  // A sideways swipe moves the window by whole axis steps (fork).
  const pan = {
    by: (steps: number) => setWindowOffsetMs((v) => v + steps * stepHours * HOUR_MS),
    // One axis step in pixels of the track.
    stepPx: () => (axisRef.current?.clientWidth ?? 0) * (stepHours / rangeHours),
  };
  const panRef = useRef(pan);
  panRef.current = pan;

  // Pinch to zoom: ctrl/cmd + wheel (a trackpad pinch) and two fingers on a
  // touch screen. Native listeners, since React's are passive and could not
  // stop the browser zooming the whole page instead.
  const chartRef = useRef<HTMLDivElement>(null);
  const hasLanes = printers.length > 0;
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    let wheel = 0;
    let sideways = 0;
    let pinch: number | null = null;
    // Safari's trackpad pinch (gesture events, with a scale): the step it last zoomed at.
    let gesture: number | null = null;
    const spread = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        // A sideways two-finger swipe (fork): the track scrolls while it can,
        // then the window moves, and the browser never takes it for Back.
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        const canScroll = e.deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        if (canScroll) return;
        e.preventDefault();
        sideways += e.deltaX;
        const stepPx = Math.max(panRef.current.stepPx(), 40);
        const steps = Math.trunc(sideways / stepPx);
        if (steps !== 0) {
          panRef.current.by(steps);
          sideways -= steps * stepPx;
        }
        return;
      }
      e.preventDefault();
      // Safari sends its pinch as gesture events too: those zoom.
      if (gesture != null) return;
      wheel += e.deltaY;
      if (Math.abs(wheel) < WHEEL_ZOOM_STEP) return;
      // Spreading the fingers (or scrolling up) zooms in.
      zoomByRef.current(wheel < 0 ? -1 : 1, e.clientX);
      wheel = 0;
    };
    type GestureLike = Event & { scale?: number; clientX?: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesture = (e as GestureLike).scale ?? 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const { scale = 1, clientX } = e as GestureLike;
      if (gesture == null) gesture = 1;
      if (scale / gesture >= PINCH_ZOOM_RATIO) {
        zoomByRef.current(-1, clientX);
        gesture = scale;
      } else if (gesture / scale >= PINCH_ZOOM_RATIO) {
        zoomByRef.current(1, clientX);
        gesture = scale;
      }
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesture = null;
    };
    const onTouchStart = (e: TouchEvent) => {
      pinch = e.touches.length === 2 ? spread(e.touches) : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pinch == null || e.touches.length !== 2) return;
      e.preventDefault();
      const current = spread(e.touches);
      const middle = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      if (current / pinch >= PINCH_ZOOM_RATIO) {
        zoomByRef.current(-1, middle);
        pinch = current;
      } else if (pinch / current >= PINCH_ZOOM_RATIO) {
        zoomByRef.current(1, middle);
        pinch = current;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart, { passive: false });
    el.addEventListener('gesturechange', onGestureChange, { passive: false });
    el.addEventListener('gestureend', onGestureEnd, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [hasLanes]);

  // Until someone zooms, the zoom follows the track's measured width (fork):
  // at least MIN_HOUR_PX an hour, so an iPad across gets 12 hours, not 24.
  useLayoutEffect(() => {
    const fit = () => {
      const width = axisRef.current?.clientWidth ?? 0;
      if (zoomChosen.current || width <= 0) return;
      setZoomIndex(zoomForTrackWidth(width));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [hasLanes]);

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
  const { data: forecast, isError: forecastFailed, isPending: forecastLoading, dataUpdatedAt } = useQuery<QueueForecast>({
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

  // ── The plan being laid out ──────────────────────────────────────────────
  // Nothing is saved until it is applied; until then the lanes show the plan.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<Draft[]>([]);
  const [applying, setApplying] = useState(false);
  // An applied plan stays drawn until the forecast that follows it comes back.
  const [settlingSince, setSettlingSince] = useState<string | null>(null);
  useEffect(() => {
    if (settlingSince != null && forecast && forecast.generated_at !== settlingSince) {
      setDraft(null);
      setHistory([]);
      setSettlingSince(null);
    }
  }, [forecast, settlingSince]);
  const planOpen = draft != null && draft.moved.length > 0 && settlingSince == null;
  // Leaving the page would lose it.
  useEffect(() => {
    if (!planOpen) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [planOpen]);

  const offTimelineIds = useMemo(
    () => new Set((forecast?.off_timeline ?? []).map((entry) => entry.item_id)),
    [forecast],
  );
  // Each printer's queued jobs as forecast, in order.
  const forecastLanes = useMemo(() => {
    const lanes: Record<number, number[]> = {};
    const placements = [...(forecast?.placements ?? [])].sort(
      (a, b) => (parseUTCDate(a.start)?.getTime() ?? 0) - (parseUTCDate(b.start)?.getTime() ?? 0),
    );
    for (const p of placements) {
      if (itemsById.get(p.item_id)?.status !== 'pending') continue;
      (lanes[p.printer_id] ??= []).push(p.item_id);
    }
    return lanes;
  }, [forecast, itemsById]);
  // The plan's lanes, kept up with the queue: a job that started or left drops
  // out, one that arrived since goes at the end of the lane it is forecast on.
  const planLanes = useMemo(() => {
    if (!draft) return null;
    const lanes: Record<number, number[]> = {};
    const inPlan = new Set<number>();
    for (const [printerId, ids] of Object.entries(draft.lanes)) {
      lanes[Number(printerId)] = ids.filter(
        (id) => itemsById.get(id)?.status === 'pending' && !offTimelineIds.has(id),
      );
      ids.forEach((id) => inPlan.add(id));
    }
    for (const [printerId, ids] of Object.entries(forecastLanes)) {
      for (const id of ids) if (!inPlan.has(id)) (lanes[Number(printerId)] ??= []).push(id);
    }
    return lanes;
  }, [draft, forecastLanes, itemsById, offTimelineIds]);
  // Fork: the queue changed under the open plan (a job the user did not move
  // changed lane or order, or one arrived or left): applying it would rewrite
  // the queue from old data, so it asks to be refreshed first.
  const planStale = useMemo(
    () => draft != null && settlingSince == null && planIsStale(draft.base, forecastLanes, draft.moved),
    [draft, settlingSince, forecastLanes],
  );

  // How a hold of an "Any" job shows on the lane `printerId` (fork); null: no hold to show there.
  const holdOn = (item: PrintQueueItem, printerId: number, reservedHere?: boolean): QueueHoldKind | null => {
    if (item.printer_id != null) return null;
    const reservation = forecast?.reservations?.[String(item.id)];
    if (!reservation) return reservedHere ? 'firm' : null;
    const { kind } = reservationState(reservation, printerId);
    if (kind !== 'firm') return kind;
    // A firm hold shows where it holds: on its printer, while it is kept to.
    return reservedHere ?? (reservation.active && reservation.printer_id === printerId) ? 'firm' : null;
  };

  // The alternative (#671) a printer prints of a job, for its name and time on that lane.
  const variantOn = (item: PrintQueueItem, printer: Printer): QueueForecastVariant | null => {
    const variants = forecast?.variants?.[String(item.id)];
    const key = modelKey(printer.model);
    return variants?.find((v) => modelKey(v.target_model) === key) ?? null;
  };

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
    return result;
  }, [queueItems, printerStatuses, nowMs]);

  // When someone is there to clear plates (fork, services/staffed_hours.py).
  const staffed = forecast?.staffed ?? null;
  // The weekly hours with the marks laid over; empty when neither is used.
  const staffedWindows = useMemo(
    () => (staffed?.windows ?? [])
      .map((w) => [parseUTCDate(w.start)?.getTime() ?? 0, parseUTCDate(w.end)?.getTime() ?? 0] as const)
      .sort((a, b) => a[0] - b[0]),
    [staffed],
  );
  // Stretches marked for given dates: nobody there (away) or someone there (here).
  const staffedMarks = useMemo(
    () => (staffed?.marks ?? [])
      .map((m) => ({
        start: parseUTCDate(m.start)?.getTime() ?? 0,
        end: parseUTCDate(m.end)?.getTime() ?? 0,
        kind: m.kind,
      }))
      .filter((m) => m.end > m.start),
    [staffed],
  );
  // Whether a mark says someone is there at `t` (true), nobody is (false), or none covers it.
  const markAt = (t: number): boolean | null => {
    let found: boolean | null = null;
    for (const m of staffedMarks) {
      if (m.start <= t && t < m.end) {
        if (m.kind === 'away') return false;
        found = true;
      }
    }
    return found;
  };
  // The first moment at or after `t` someone is there (PlateTurnaround.next_staffed).
  const nextStaffed = (t: number): number => {
    const shift = staffedWindows.find(([, closes]) => closes > t);
    return shift ? Math.max(t, shift[0]) : t;
  };
  // What the forecast learned of how long plates wait (fork, services/plate_clears.py).
  const typical = staffed?.typical ?? null;
  const typicalStartMs = parseUTCDate(typical?.start)?.getTime() ?? null;
  const awayUntilMs = parseUTCDate(staffed?.away_until)?.getTime() ?? null;
  const presentUntilMs = parseUTCDate(staffed?.present_until)?.getTime() ?? null;
  // When someone is expected to be there to press Start (PlateTurnaround.someone_there).
  const someoneThereMs = parseUTCDate(staffed?.someone_there_at)?.getTime() ?? null;
  const generatedMs = parseUTCDate(forecast?.generated_at)?.getTime() ?? nowMs;
  // When a printer whose print ends at `endMs` can start the next one, and why
  // then, as the forecast has it (PlateTurnaround.explain).
  const explainWait = (endMs: number): { at: number; reason: PlateWaitReason } => {
    if (!staffed?.waits_for_plate) return { at: endMs, reason: 'clear' };
    const clear = staffed.clear_minutes * 60_000;
    // Someone cleared a plate a moment ago: they clear this one too.
    if (presentUntilMs != null && generatedMs <= endMs && endMs < presentUntilMs) {
      return { at: endMs + clear, reason: 'clear' };
    }
    const opens = nextStaffed(endMs);
    let at = opens + clear;
    let reason: PlateWaitReason = 'clear';
    if (opens > endMs) {
      const marked = markAt(endMs) === false
        || staffedMarks.some((m) => m.kind === 'away' && m.end === opens && m.start < opens);
      reason = marked ? 'absent' : 'unstaffed';
    }
    // How long plates usually wait then, unless a mark says who is there.
    if (typical && typicalStartMs != null && typical.minutes.length > 0 && markAt(endMs) === null) {
      const n = typical.minutes.length;
      const hour = ((Math.floor((endMs - typicalStartMs) / 3_600_000) % n) + n) % n;
      let usual = endMs + typical.minutes[hour] * 60_000;
      if (usual > at) {
        let why: PlateWaitReason = 'typical';
        const hereFrom = Math.min(
          ...staffedMarks.filter((m) => m.kind === 'here' && endMs < m.start && m.start < usual).map((m) => m.start),
        );
        if (Number.isFinite(hereFrom)) {
          // Someone marked to come clears it then.
          usual = Math.min(usual, nextStaffed(hereFrom) + clear);
        } else if (markAt(usual) === false) {
          // Running into a marked absence: until it is over.
          usual = nextStaffed(usual) + clear;
          why = 'absent';
        }
        if (usual > at) {
          at = usual;
          reason = why;
        }
      }
    }
    // Nobody seems to be there: whoever comes next clears it.
    if (awayUntilMs != null && endMs < awayUntilMs && awayUntilMs > at) {
      at = awayUntilMs;
      reason = 'away';
    }
    return { at, reason };
  };

  // Queued jobs on each lane: where the forecast has them, or where the plan
  // does; and the stretches a printer stands with a finished plate.
  const { queuedByPrinter, plateWaitsByPrinter } = useMemo(() => {
    const map = new Map<number, ScheduleEvent[]>();
    const waits = new Map<number, PlateWaitSpan[]>();
    const addWait = (printerId: number, start: number, end: number, reason: PlateWaitReason) => {
      if (end <= start) return;
      if (!waits.has(printerId)) waits.set(printerId, []);
      waits.get(printerId)!.push({ start, end, reason });
    };
    if (planLanes && draft) {
      // Before its first job: the plate it has now, as forecast.
      for (const w of forecast?.plate_waits ?? []) {
        const end = parseUTCDate(w.end)?.getTime();
        const free = parseUTCDate(lanePrinterState.get(w.printer_id)?.free_at)?.getTime();
        if (end != null && free != null && end === free) {
          addWait(w.printer_id, parseUTCDate(w.start)?.getTime() ?? end, end, w.reason ?? 'clear');
        }
      }
      // Back to back from when the printer is free, as the forecast replays them.
      for (const printer of printers) {
        const free = parseUTCDate(lanePrinterState.get(printer.id)?.free_at)?.getTime() ?? nowMs;
        let t = Math.max(free, nowMs);
        for (const id of planLanes[printer.id] ?? []) {
          const item = itemsById.get(id);
          if (!item) continue;
          const variant = variantOn(item, printer);
          const scheduled = parseUTCDate(item.scheduled_time)?.getTime();
          if (scheduled != null && scheduled > t) t = scheduled;
          // A manual start waits for someone to be there, as the forecast has it.
          if (item.manual_start && someoneThereMs != null && someoneThereMs > t) t = someoneThereMs;
          const duration = (variant?.print_time_seconds ?? item.print_time_seconds ?? 3600) * 1000;
          const moved = draft.moved.includes(id);
          if (!map.has(printer.id)) map.set(printer.id, []);
          map.get(printer.id)!.push({
            item,
            estimatedStart: new Date(t),
            estimatedEnd: new Date(t + duration),
            type: 'queued',
            projected: item.printer_id == null,
            variant,
            moved,
            // A moved "Any" job becomes a firm hold once applied.
            hold: item.printer_id == null && moved ? 'firm' : holdOn(item, printer.id),
          });
          const end = t + duration;
          const next = explainWait(end);
          t = next.at;
          addWait(printer.id, end, t, next.reason);
        }
      }
      return { queuedByPrinter: map, plateWaitsByPrinter: waits };
    }
    for (const w of forecast?.plate_waits ?? []) {
      const start = parseUTCDate(w.start)?.getTime();
      const end = parseUTCDate(w.end)?.getTime();
      if (start != null && end != null) addWait(w.printer_id, start, end, w.reason ?? 'clear');
    }
    for (const placement of forecast?.placements ?? []) {
      const item = itemsById.get(placement.item_id);
      if (!item || item.status !== 'pending') continue;
      const start = parseUTCDate(placement.start);
      const end = parseUTCDate(placement.end);
      if (!start || !end) continue;
      if (!map.has(placement.printer_id)) map.set(placement.printer_id, []);
      map.get(placement.printer_id)!.push({
        item,
        estimatedStart: start,
        estimatedEnd: end,
        type: 'queued',
        projected: placement.projected,
        variant: placement.variant ?? null,
        hold: holdOn(item, placement.printer_id, placement.reserved),
      });
    }
    return { queuedByPrinter: map, plateWaitsByPrinter: waits };
    // variantOn and explainWait read forecast, staffedWindows and staffedMarks, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planLanes, draft, printers, lanePrinterState, nowMs, itemsById, forecast, staffedWindows, staffedMarks]);
  const hasManualStart = useMemo(
    () => Array.from(queuedByPrinter.values()).some((evs) => evs.some((ev) => ev.item.manual_start)),
    [queuedByPrinter],
  );

  // The stretches of the window nobody is there, shaded on the lanes.
  const unstaffed = useMemo(() => {
    if (staffedWindows.length === 0) return [];
    const gaps: Array<{ start: number; end: number }> = [];
    let cursor = rangeStartMs;
    for (const [opens, closes] of staffedWindows) {
      if (closes <= cursor) continue;
      if (opens >= rangeEndMs) break;
      if (opens > cursor) gaps.push({ start: cursor, end: opens });
      cursor = Math.max(cursor, closes);
    }
    if (cursor < rangeEndMs) gaps.push({ start: cursor, end: rangeEndMs });
    return gaps;
  }, [staffedWindows, rangeStartMs, rangeEndMs]);
  const visibleMarks = staffedMarks.filter((m) => m.end > rangeStartMs && m.start < rangeEndMs);
  const markedAwayNow = staffedMarks.find((m) => m.kind === 'away' && m.start <= nowMs && nowMs < m.end) ?? null;
  const [staffedOpen, setStaffedOpen] = useState(false);
  const shortTime = (ms: number) =>
    new Date(ms).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const clockTime = (ms: number) => formatTooltipTime(new Date(ms), language);
  // What a plate wait's tooltip says: until when, and why.
  const plateWaitText = (w: PlateWaitSpan): string => {
    const time = shortTime(w.end);
    const waited = formatDuration(Math.max(0, generatedMs - w.start) / 1000);
    switch (w.reason) {
      case 'typical':
        return t('queue.timeline.plateWaitTypical', { duration: formatDuration((w.end - w.start) / 1000), time });
      case 'waiting':
        return t('queue.timeline.plateWaitWaiting', { duration: waited, time });
      case 'absent':
        return t('queue.timeline.plateWaitAbsent', { time });
      case 'away':
        return w.start < generatedMs
          ? t('queue.timeline.plateWaitAway', { duration: waited, time })
          : t('queue.timeline.plateWaitAwayLater', { time });
      default:
        return t('queue.timeline.plateWait', { time });
    }
  };

  const eventsByPrinter = useMemo(() => {
    const map = new Map<number, ScheduleEvent[]>();
    for (const ev of events) {
      if (ev.item.printer_id == null) continue;
      if (!map.has(ev.item.printer_id)) map.set(ev.item.printer_id, []);
      map.get(ev.item.printer_id)!.push(ev);
    }
    for (const [printerId, queued] of queuedByPrinter) {
      map.set(printerId, [...(map.get(printerId) ?? []), ...queued]);
    }
    return map;
  }, [events, queuedByPrinter]);
  const allEvents = useMemo(() => Array.from(eventsByPrinter.values()).flat(), [eventsByPrinter]);

  // Fork: the lanes fill the room the screen has below them, a share per
  // printer, so the bars can show more. Measured from where the lanes start.
  const lanesRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(LANE_BAR_HEIGHT_PX);
  const offTimelineCount = forecast?.off_timeline?.length ?? 0;
  useLayoutEffect(() => {
    const fit = () => {
      const lanes = lanesRef.current;
      if (!lanes) return;
      const top = lanes.getBoundingClientRect().top + window.scrollY;
      const reserve = LANES_BOTTOM_RESERVE_PX + (offTimelineCount > 0 ? OFF_TIMELINE_RESERVE_PX : 0);
      setBarHeight(fitBarHeight(top, window.innerHeight, printers.length, reserve));
    };
    fit();
    window.addEventListener('resize', fit);
    // What is above the lanes may load or wrap after they do.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [printers.length, offTimelineCount]);

  const offTimeline = useMemo(
    () => (forecast?.off_timeline ?? [])
      .map((entry) => ({ entry, item: itemsById.get(entry.item_id) }))
      .filter((row): row is { entry: QueueForecast['off_timeline'][number]; item: PrintQueueItem } =>
        row.item != null && row.item.status === 'pending'),
    [forecast, itemsById],
  );

  const hourTicks = useMemo(() => {
    const ticks: { ms: number; pct: number; label: string }[] = [];
    for (let h = 0; h <= rangeHours; h += stepHours) {
      const ms = rangeStartMs + h * HOUR_MS;
      const date = new Date(ms);
      // Half hours need the minutes; over a day, the first tick of a day names it.
      const label = stepHours < 1
        ? formatTooltipTime(date, language)
        : rangeHours > 24 && date.getHours() < stepHours
          ? `${date.toLocaleDateString(language, { weekday: 'short' })} ${formatHour(date, language)}`
          : formatHour(date, language);
      ticks.push({ ms, pct: (h / rangeHours) * 100, label });
    }
    return ticks;
  }, [rangeStartMs, rangeHours, stepHours, language]);

  const nowPct = ((nowMs - rangeStartMs) / rangeMs) * 100;
  const nowInView = nowPct >= 0 && nowPct <= 100;

  // Aggregated "all done by" across the entire (un-windowed) event set: the
  // plan's while one is laid out, and the forecast's to compare with.
  const allDoneBy = useMemo(() => {
    let latest = 0;
    for (const ev of allEvents) latest = Math.max(latest, ev.estimatedEnd.getTime());
    return latest > 0 ? new Date(latest) : null;
  }, [allEvents]);
  const forecastDoneBy = useMemo(() => {
    let latest = 0;
    for (const ev of events) latest = Math.max(latest, ev.estimatedEnd.getTime());
    for (const p of forecast?.placements ?? []) latest = Math.max(latest, parseUTCDate(p.end)?.getTime() ?? 0);
    return latest > 0 ? new Date(latest) : null;
  }, [events, forecast]);

  // ── Drag and drop: laying out the plan ────────────────────────────────────
  const mayModify = (item: PrintQueueItem): boolean => (canModifyItem ? canModifyItem(item) : true);
  const isDraggable = (item: PrintQueueItem): boolean =>
    onApplyPlan != null && canReorder && item.status === 'pending' && settlingSince == null && mayModify(item);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // A short press on touch, so a swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const [dragItem, setDragItem] = useState<PrintQueueItem | null>(null);
  const dragEvent = useMemo(
    () => (dragItem ? allEvents.find((ev) => ev.item.id === dragItem.id) ?? null : null),
    [dragItem, allEvents],
  );
  // The gap the dragged job would drop into.
  const [dropTarget, setDropTarget] = useState<{
    printerId: number;
    x: number;
    anchorId: number | null;
    placeAfter: boolean;
  } | null>(null);

  // Why an "Any" job may not wait for this printer, if it may not.
  const laneRefusal = (item: PrintQueueItem, printerId: number): QueueForecastRefusal | null => {
    const refusals = forecast?.reserve_refusals ?? forecast?.refusals;
    return refusals?.[String(item.id)]?.[String(printerId)] ?? null;
  };
  const laneDragState = (printerId: number) => {
    if (!dragItem) return null;
    if (dragItem.printer_id != null) {
      // A pinned job keeps its printer: on its lane it only changes place.
      // Moving it is a choice made in its details.
      return dragItem.printer_id === printerId
        ? { allowed: true, reason: null }
        : {
            allowed: false,
            reason: t('queue.timeline.drop.pinnedElsewhere', {
              printer: printersById.get(dragItem.printer_id)?.name ?? `#${dragItem.printer_id}`,
            }),
          };
    }
    // An "Any" job put on a lane waits for that printer: the scheduler's rule.
    const refusal = laneRefusal(dragItem, printerId);
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

  // A drop puts the job into the gap, on its lane or another, in the plan.
  const handleDragEnd = (event: DragEndEvent) => {
    const item = dragItem;
    setDragItem(null);
    setDropTarget(null);
    // A finger held a moment starts a drag, and dnd-kit then eats the click
    // (fork): a drag that hardly moved was a tap, so it opens the job.
    if (item && Math.hypot(event.delta.x, event.delta.y) < TAP_SLOP_PX) {
      setDetails({ itemId: item.id });
      return;
    }
    const target = gapFor(event);
    if (!item || !target || !onApplyPlan || planStale) return;
    const base: Draft = draft && planLanes
      ? { lanes: planLanes, moved: draft.moved, base: draft.base }
      : { lanes: forecastLanes, moved: [], base: forecastLanes };
    const lanes: Record<number, number[]> = {};
    for (const [printerId, ids] of Object.entries(base.lanes)) {
      lanes[Number(printerId)] = ids.filter((id) => id !== item.id);
    }
    const lane = [...(lanes[target.printerId] ?? [])];
    let index = target.anchorId == null ? -1 : lane.indexOf(target.anchorId);
    index = index === -1 ? lane.length : index + (target.placeAfter ? 1 : 0);
    lane.splice(index, 0, item.id);
    lanes[target.printerId] = lane;
    const unchanged = Object.keys({ ...lanes, ...base.lanes }).every(
      (printerId) => (lanes[Number(printerId)] ?? []).join() === (base.lanes[Number(printerId)] ?? []).join(),
    );
    if (unchanged) return;
    setHistory((past) => [...past, base]);
    setDraft({ lanes, moved: base.moved.includes(item.id) ? base.moved : [...base.moved, item.id], base: base.base });
  };

  const undoPlan = () => {
    const previous = history[history.length - 1];
    setHistory((past) => past.slice(0, -1));
    setDraft(previous && previous.moved.length > 0 ? previous : null);
  };
  const discardPlan = () => {
    setDraft(null);
    setHistory([]);
  };
  // Fork: the user's moves laid again onto the forecast as it is now.
  const refreshPlan = () => {
    if (!draft) return;
    const next = rebasePlan(draft, forecastLanes, (id, printerId) => {
      const item = itemsById.get(id);
      if (!item || item.status !== 'pending' || offTimelineIds.has(id)) return false;
      if (item.printer_id != null) return item.printer_id === printerId;
      return !laneRefusal(item, printerId);
    });
    setDraft(next);
    setHistory([]);
  };
  const applyPlan = async () => {
    if (!draft || !planLanes || !onApplyPlan || planStale) return;
    const onLanes = new Set(Object.values(planLanes).flat());
    // The moved "Any" jobs wait for the printer they were put on.
    const reserve = draft.moved.filter((id) => onLanes.has(id) && itemsById.get(id)?.printer_id == null);
    // Only the lanes the user changed: the server keeps the places of the
    // jobs it is not sent, so a lane laid out on old data is not rewritten.
    const changed = printers.filter(
      (p) => (planLanes[p.id] ?? []).join() !== (draft.base[p.id] ?? []).join(),
    );
    setApplying(true);
    try {
      await onApplyPlan({
        lanes: changed.map((p) => ({ printer_id: p.id, item_ids: planLanes[p.id] ?? [] })),
        reserve,
      });
      setSettlingSince(forecast?.generated_at ?? '');
    } catch {
      // The page says why; the plan stays, to fix or discard.
    } finally {
      setApplying(false);
    }
  };

  // ── The open job's details ────────────────────────────────────────────────
  const detailsItem = details ? itemsById.get(details.itemId) ?? null : null;
  const detailsEvent = detailsItem ? allEvents.find((ev) => ev.item.id === detailsItem.id) ?? null : null;
  const detailsLane = detailsItem
    ? detailsItem.status === 'printing'
      ? detailsItem.printer_id
      : Array.from(queuedByPrinter.entries()).find(([, evs]) => evs.some((ev) => ev.item.id === detailsItem.id))?.[0] ?? null
    : null;
  const detailsExpected = detailsEvent && detailsLane != null
    ? { printerId: detailsLane, start: detailsEvent.estimatedStart, end: detailsEvent.estimatedEnd }
    : null;
  const detailsOff = detailsItem ? offTimeline.find((row) => row.item.id === detailsItem.id)?.entry : undefined;
  const detailsHeld = detailsOff
    ? detailsOff.reason === 'waiting' && detailsOff.detail
      ? translateWaitingReason(detailsOff.detail, t)
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
  const detailsReservation = detailsItem && detailsItem.printer_id == null
    ? forecast?.reservations?.[String(detailsItem.id)] ?? null
    : null;
  const detailsHold = detailsReservation ? reservationState(detailsReservation, detailsLane) : null;
  // A job linked to (?item=<id>) opens once; one that no longer exists opens nothing.
  useEffect(() => {
    if (focusItemId == null) return;
    if (itemsById.has(focusItemId)) setDetails({ itemId: focusItemId });
    onFocusItemDone?.();
  }, [focusItemId, itemsById, onFocusItemDone]);
  // A job that went away (started elsewhere, removed) closes its details.
  useEffect(() => {
    if (details && !detailsItem) setDetails(null);
  }, [details, detailsItem]);

  // ── Taps that explain (fork): what hovers said, a tap now shows ───────────
  const [info, setInfo] = useState<{ text: string; x: number; y: number } | null>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const showInfo = (e: ReactMouseEvent, text: string) => {
    e.stopPropagation();
    setInfo({ text, x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    if (!info) return;
    const close = (e: Event) => {
      if (!infoRef.current?.contains(e.target as Node)) setInfo(null);
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [info]);

  // The legend and the hints, folded behind "?" (fork).
  const [helpOpen, setHelpOpen] = useState(storedHelpOpen);
  const toggleHelp = () => {
    setHelpOpen((open) => {
      try {
        localStorage.setItem(HELP_STORAGE_KEY, open ? '0' : '1');
      } catch {
        // Private mode: not remembered.
      }
      return !open;
    });
  };
  const holdsShown = useMemo(() => {
    const kinds = new Set<QueueHoldKind>();
    for (const ev of allEvents) if (ev.hold) kinds.add(ev.hold);
    return kinds;
  }, [allEvents]);

  // Screen-reader words for dragging, in the app's language (fork).
  const nameOfDragged = (id: string | number) => {
    const item = itemsById.get(Number(String(id).replace('item-', '')));
    return item ? queueJobName(item) : String(id);
  };
  const laneName = (over: { data: { current?: Record<string, unknown> } } | null) => {
    const printerId = over?.data.current?.printerId as number | undefined;
    return printerId != null ? printersById.get(printerId)?.name ?? `#${printerId}` : null;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('queue.timeline.a11y.dragStart', { name: nameOfDragged(active.id) }),
    onDragOver: ({ active, over }) => {
      const printer = laneName(over);
      return printer
        ? t('queue.timeline.a11y.dragOver', { name: nameOfDragged(active.id), printer })
        : t('queue.timeline.a11y.dragOverNone', { name: nameOfDragged(active.id) });
    },
    onDragEnd: ({ active, over }) => {
      const printer = laneName(over);
      return printer
        ? t('queue.timeline.a11y.drop', { name: nameOfDragged(active.id), printer })
        : t('queue.timeline.a11y.dragCancel', { name: nameOfDragged(active.id) });
    },
    onDragCancel: ({ active }) => t('queue.timeline.a11y.dragCancel', { name: nameOfDragged(active.id) }),
  };

  const rangeLabelOptions: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

  return (
    <div>
      {/* The plan laid out by dragging, until it is applied or dropped. Fork:
          laid over the controls in a zero-height sticky row, so nothing below
          moves or changes height when it comes or goes, and it stays in view
          under the compact header while the page scrolls. */}
      <div className="sticky top-[var(--app-top,0px)] z-40 h-0">
        {planOpen && (
          <div
            className={`absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-bambu-dark-secondary px-3 py-2 shadow-lg ${
              planStale ? 'border-red-400/60' : 'border-amber-400/40'
            }`}
            data-testid="timeline-plan-bar"
            data-stale={planStale ? 'true' : undefined}
          >
            {planStale ? (
              <>
                <AlertTriangle className="w-4 h-4 text-red-300 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white font-medium">{t('queue.timeline.plan.stale')}</div>
                  <div className="text-xs text-bambu-gray">{t('queue.timeline.plan.staleHelp')}</div>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <Button variant="secondary" size="sm" onClick={discardPlan}>
                    <X className="w-4 h-4 mr-1" />
                    {t('queue.timeline.plan.discard')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={refreshPlan}>
                    <RefreshCw className="w-4 h-4 mr-1" />
                    {t('queue.timeline.plan.refresh')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <PencilRuler className="w-4 h-4 text-amber-300 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white font-medium flex items-center gap-1">
                    {t('queue.timeline.plan.unsaved', { count: draft!.moved.length })}
                    <button
                      type="button"
                      onClick={(e) => showInfo(e, t('queue.timeline.plan.hint'))}
                      className="inline-flex items-center justify-center rounded-full text-bambu-gray hover:text-white any-pointer-coarse:min-w-[44px] any-pointer-coarse:min-h-[44px]"
                      aria-label={t('queue.timeline.help.planHint')}
                      data-testid="timeline-plan-hint"
                    >
                      <HelpCircle className="w-4 h-4" aria-hidden />
                    </button>
                  </div>
                  {allDoneBy && forecastDoneBy && (
                    <div className="text-xs text-bambu-gray truncate">
                      {t('queue.timeline.plan.doneBy', {
                        time: shortTime(allDoneBy.getTime()),
                        was: shortTime(forecastDoneBy.getTime()),
                      })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <Button variant="ghost" size="sm" onClick={undoPlan} disabled={history.length === 0 || applying}>
                    <Undo2 className="w-4 h-4 mr-1" />
                    {t('queue.timeline.plan.undo')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={discardPlan} disabled={applying}>
                    <X className="w-4 h-4 mr-1" />
                    {t('queue.timeline.plan.discard')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={applyPlan} disabled={applying}>
                    {applying ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Check className="w-4 h-4 mr-1" />}
                    {t('queue.timeline.plan.apply')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Window controls (fork): one row with the date, the zoom, the staffed
          hours, replanning and the legend's "?". */}
      <div className="flex flex-wrap items-center gap-1 mb-2" data-testid="timeline-toolbar">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setWindowOffsetMs((v) => v - rangeMs / 2)}
          className="p-1.5"
          title={t('queue.timeline.window.back', { hours: rangeHours / 2 })}
          aria-label={t('queue.timeline.window.back', { hours: rangeHours / 2 })}
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-xs sm:text-sm font-medium text-white text-center tabular-nums" data-testid="timeline-range">
          {new Date(rangeStartMs).toLocaleString(language, rangeLabelOptions)}
          {' → '}
          {new Date(rangeEndMs).toDateString() === new Date(rangeStartMs).toDateString()
            ? clockTime(rangeEndMs)
            : new Date(rangeEndMs).toLocaleString(language, rangeLabelOptions)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setWindowOffsetMs((v) => v + rangeMs / 2)}
          className="p-1.5"
          title={t('queue.timeline.window.forward', { hours: rangeHours / 2 })}
          aria-label={t('queue.timeline.window.forward', { hours: rangeHours / 2 })}
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
        <div className="flex items-center gap-0.5 sm:ml-1 sm:pl-2 sm:border-l border-bambu-dark-tertiary">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => zoomBy(1)}
            disabled={zoomIndex === ZOOM_HOURS.length - 1}
            className="p-1.5"
            title={t('queue.timeline.window.zoomOut')}
            aria-label={t('queue.timeline.window.zoomOut')}
          >
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-xs text-bambu-gray w-9 text-center tabular-nums" data-testid="timeline-zoom">
            {rangeHours} h
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => zoomBy(-1)}
            disabled={zoomIndex === 0}
            className="p-1.5"
            title={t('queue.timeline.window.zoomIn')}
            aria-label={t('queue.timeline.window.zoomIn')}
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
        </div>
        {/* What is going on: the forecast, nobody there, when all is done.
            In the row on a wide screen; on a narrow one, a line of its own below. */}
        <div className="order-last lg:order-none basis-full lg:basis-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs lg:ml-2">
          {forecastLoading && (
            <span className="text-bambu-gray flex items-center gap-1.5" data-testid="timeline-forecast-loading" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
              {t('queue.timeline.forecastLoading')}
            </span>
          )}
          {forecastFailed && forecast && (
            <span className="text-amber-300 flex items-center gap-1.5" data-testid="timeline-forecast-stale" role="status">
              <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
              {t('queue.timeline.forecastStale', { time: clockTime(dataUpdatedAt) })}
            </span>
          )}
          {awayUntilMs != null && awayUntilMs > nowMs && (
            <button
              type="button"
              className="text-amber-300 flex items-center gap-1.5 text-left any-pointer-coarse:min-h-[44px]"
              data-testid="timeline-away"
              title={t('queue.timeline.awayHelp')}
              onClick={(e) => showInfo(e, t('queue.timeline.awayHelp'))}
            >
              <UserX className="w-3.5 h-3.5 shrink-0" />
              {t('queue.timeline.away', { time: shortTime(awayUntilMs) })}
              <HelpCircle className="w-3.5 h-3.5 shrink-0 opacity-70" aria-hidden />
            </button>
          )}
          {markedAwayNow && (
            <button
              type="button"
              onClick={() => setStaffedOpen(true)}
              className="text-red-200 flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-red-400/30 bg-red-500/10 hover:bg-red-500/20 any-pointer-coarse:min-h-[44px]"
              data-testid="timeline-marked-away"
            >
              <UserX className="w-3.5 h-3.5" />
              {t('queue.timeline.absent', { time: shortTime(markedAwayNow.end) })}
            </button>
          )}
          {allDoneBy && (
            <span className="text-bambu-gray flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {t('queue.timeline.allDoneBy', { time: shortTime(allDoneBy.getTime()) })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStaffedOpen(true)}
            className="text-xs"
            title={t('queue.timeline.staffed.title')}
            aria-label={t('queue.timeline.staffed.button')}
          >
            <CalendarClock className="w-4 h-4" />
            <span className="hidden sm:inline">{t('queue.timeline.staffed.button')}</span>
          </Button>
          {onReplanQueue && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReplanQueue}
              disabled={replanning}
              className="text-xs"
              title={t('queue.timeline.replan.title')}
              aria-label={t('queue.timeline.replan.button')}
              data-testid="timeline-replan"
            >
              <RefreshCw className={`w-4 h-4 ${replanning ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('queue.timeline.replan.button')}</span>
            </Button>
          )}
          <Button
            variant={helpOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={toggleHelp}
            className="p-1.5"
            aria-expanded={helpOpen}
            aria-label={t('queue.timeline.help.toggle')}
            title={t('queue.timeline.help.toggle')}
            data-testid="timeline-help-toggle"
          >
            <HelpCircle className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Legend and hints, behind the "?" (fork): what each bar means. */}
      {helpOpen && (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3 text-xs text-bambu-gray" data-testid="timeline-legend">
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
        <span className="flex items-center gap-1.5" data-testid="legend-hold-firm">
          <span className="inline-flex w-5 h-3.5 rounded-sm bg-amber-500/15 border border-amber-400/60" />
          <Lock className="w-3 h-3" aria-hidden />
          {t('queue.timeline.legend.reserved')}
        </span>
        {holdsShown.has('soft') && (
          <span className="flex items-center gap-1.5" data-testid="legend-hold-soft">
            <span className="inline-flex w-5 h-3.5 rounded-sm bg-amber-500/10 border border-dashed border-amber-400/70" />
            <Bookmark className="w-3 h-3" aria-hidden />
            {t('queue.timeline.hold.legendSoft')}
          </span>
        )}
        {holdsShown.has('gaveWay') && (
          <span className="flex items-center gap-1.5" data-testid="legend-hold-gave-way">
            <span className="inline-flex w-5 h-3.5 rounded-sm bg-bambu-green/10 border border-dashed border-bambu-green/70" />
            <BookmarkX className="w-3 h-3" aria-hidden />
            {t('queue.timeline.hold.legendGaveWay')}
          </span>
        )}
        {planOpen && (
          <span className="flex items-center gap-1.5" data-testid="legend-moved">
            <span className="inline-flex w-5 h-3.5 rounded-sm outline-2 outline-dashed outline-white/80" />
            <Move className="w-3 h-3" aria-hidden />
            {t('queue.timeline.hold.legendMoved')}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="inline-flex w-5 h-3.5 rounded-sm bg-blue-500/30 border border-blue-400/60" />
          {t('queue.timeline.legend.printing')}
        </span>
        {hasManualStart && (
          <span className="flex items-center gap-1.5" data-testid="legend-manual">
            <Hand className="w-3 h-3" aria-hidden />
            {t('queue.timeline.legend.manual')}
          </span>
        )}
        {staffed?.waits_for_plate && (
          <span className="flex items-center gap-1.5">
            <span className="inline-flex w-5 h-3.5 rounded-sm border border-dashed border-bambu-gray/50" style={{ backgroundImage: PLATE_WAIT_PATTERN }} />
            {t('queue.timeline.legend.plateWait')}
          </span>
        )}
        {staffed?.enabled && (
          <span className="flex items-center gap-1.5">
            <span className="inline-flex w-5 h-3.5 rounded-sm bg-black/40" />
            <Moon className="w-3 h-3" aria-hidden />
            {t('queue.timeline.legend.unstaffed')}
          </span>
        )}
        {visibleMarks.some((m) => m.kind === 'away') && (
          <span className="flex items-center gap-1.5" data-testid="legend-absent">
            <span className="inline-flex w-5 h-3.5 rounded-sm" style={{ backgroundImage: AWAY_STRIPES }} />
            {t('queue.timeline.legend.absent')}
          </span>
        )}
        {visibleMarks.some((m) => m.kind === 'here') && (
          <span className="flex items-center gap-1.5" data-testid="legend-here">
            <span className="inline-flex w-5 h-1.5 rounded-full bg-bambu-green/70" />
            {t('queue.timeline.legend.here')}
          </span>
        )}
        <span className="basis-full">{t('queue.timeline.window.zoomHint')}</span>
        {onApplyPlan && (
          <span className="basis-full italic">
            {canReorder ? t('queue.timeline.legend.dragHint') : t('queue.timeline.legend.sjfHint')}
          </span>
        )}
        {onApplyPlan && canReorder && <span className="basis-full">{t('queue.timeline.plan.hint')}</span>}
      </div>
      )}

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
        <BarHeightContext.Provider value={barHeight}>
        <DndContext
          sensors={sensors}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('queue.timeline.a11y.instructions') },
          }}
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
          {/* overscroll-x-contain: a sideways swipe ends here, never as the browser's Back (fork). */}
          <div ref={chartRef} className="overflow-x-auto overscroll-x-contain touch-pan-x touch-pan-y">
          <div className="min-w-[720px]">
            {/* Hour axis */}
            <div className="flex border-b border-bambu-dark-tertiary">
              <div className="w-32 sm:w-40 shrink-0 px-3 py-2 text-xs font-medium text-bambu-gray border-r border-bambu-dark-tertiary sticky left-0 z-30 bg-bambu-dark-secondary">
                {t('queue.timeline.printerColumnHeader')}
              </div>
              <div ref={axisRef} className="relative flex-1 h-9">
                {hourTicks.map((tick) => (
                  <div
                    key={tick.ms}
                    className="absolute top-0 bottom-0 border-l border-bambu-dark-tertiary/40 text-[10px] sm:text-xs text-bambu-gray pl-1 flex items-center"
                    style={{ left: `${tick.pct}%` }}
                  >
                    {tick.label}
                  </div>
                ))}
                {/* Marked stretches, along the bottom of the axis. */}
                {visibleMarks.map((m) => {
                  const startMs = Math.max(rangeStartMs, m.start);
                  const endMs = Math.min(rangeEndMs, m.end);
                  const text = t(m.kind === 'away' ? 'queue.timeline.markAway' : 'queue.timeline.markHere', {
                    from: shortTime(m.start),
                    to: shortTime(m.end),
                  });
                  // A tap says what is marked (fork): a taller, invisible hit area over the thin stripe.
                  return (
                    <button
                      type="button"
                      key={`${m.kind}-${m.start}`}
                      className="absolute bottom-0 h-4 flex items-end"
                      data-testid="axis-mark"
                      data-kind={m.kind}
                      title={text}
                      aria-label={text}
                      onClick={(e) => showInfo(e, text)}
                      style={{
                        left: `${((startMs - rangeStartMs) / rangeMs) * 100}%`,
                        width: `${((endMs - startMs) / rangeMs) * 100}%`,
                      }}
                    >
                      <span
                        className={`block w-full h-1.5 rounded-full ${m.kind === 'here' ? 'bg-bambu-green/70' : ''}`}
                        style={{ backgroundImage: m.kind === 'away' ? AWAY_STRIPES : undefined }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Lanes */}
            <div className="relative" ref={lanesRef}>
              {/* Nobody there to clear plates: shaded behind the lanes. */}
              {unstaffed.length > 0 && (
                <div className="absolute inset-0 flex pointer-events-none" aria-hidden>
                  <div className="w-32 sm:w-40 shrink-0" />
                  <div className="relative flex-1">
                    {unstaffed.map((gap) => (
                      <div
                        key={gap.start}
                        className="absolute top-0 bottom-0 bg-black/30"
                        data-testid="unstaffed"
                        style={{
                          left: `${((gap.start - rangeStartMs) / rangeMs) * 100}%`,
                          width: `${((gap.end - gap.start) / rangeMs) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
              {/* Marked: nobody there. Tinted over the shading. */}
              {visibleMarks.some((m) => m.kind === 'away') && (
                <div className="absolute inset-0 flex pointer-events-none" aria-hidden>
                  <div className="w-32 sm:w-40 shrink-0" />
                  <div className="relative flex-1">
                    {visibleMarks
                      .filter((m) => m.kind === 'away')
                      .map((m) => {
                        const startMs = Math.max(rangeStartMs, m.start);
                        const endMs = Math.min(rangeEndMs, m.end);
                        return (
                          <div
                            key={m.start}
                            className="absolute top-0 bottom-0 bg-red-500/10 border-x border-dashed border-red-400/30"
                            data-testid="marked-away"
                            style={{
                              left: `${((startMs - rangeStartMs) / rangeMs) * 100}%`,
                              width: `${((endMs - startMs) / rangeMs) * 100}%`,
                            }}
                          />
                        );
                      })}
                  </div>
                </div>
              )}
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
                              left: `${((startMs - rangeStartMs) / rangeMs) * 100}%`,
                              width: `max(${MIN_BAR_PX}px, ${((endMs - startMs) / rangeMs) * 100}%)`,
                              top: LANE_PADDING_PX / 2,
                              height: barHeight,
                            }}
                            title={t('queue.timeline.externalPrint')}
                          >
                            <span className="truncate">{t('queue.timeline.externalPrint')}</span>
                          </div>
                        );
                      })()}

                      {/* The finished plate waiting for someone to clear it. */}
                      {(plateWaitsByPrinter.get(printer.id) ?? []).map((w) => {
                        const startMs = Math.max(rangeStartMs, w.start);
                        const endMs = Math.min(rangeEndMs, w.end);
                        if (endMs <= startMs) return null;
                        const away = w.reason === 'away';
                        const absent = w.reason === 'absent';
                        const label = away
                          ? t('queue.timeline.plateAway')
                          : absent
                            ? t('queue.timeline.plateAbsent')
                            : t('queue.timeline.legend.plateWait');
                        // A tap says until when and why (fork); the label says until when where it fits.
                        return (
                          <button
                            type="button"
                            key={`plate-${w.start}`}
                            onClick={(e) => showInfo(e, plateWaitText(w))}
                            aria-label={plateWaitText(w)}
                            className={`absolute rounded-md border border-dashed flex items-center px-1.5 overflow-hidden text-[10px] text-left ${
                              away
                                ? 'border-amber-400/50 text-amber-200/90'
                                : absent
                                  ? 'border-red-400/40 text-red-200/90'
                                  : 'border-bambu-gray/40 text-bambu-gray'
                            }`}
                            data-testid={`plate-wait-${printer.id}`}
                            data-reason={w.reason}
                            title={plateWaitText(w)}
                            style={{
                              left: `${((startMs - rangeStartMs) / rangeMs) * 100}%`,
                              width: `${((endMs - startMs) / rangeMs) * 100}%`,
                              top: LANE_PADDING_PX / 2,
                              height: barHeight,
                              backgroundImage: PLATE_WAIT_PATTERN,
                            }}
                          >
                            <span className="truncate">
                              {label} · {clockTime(w.end)}
                            </span>
                          </button>
                        );
                      })}

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
                            leftPct={((startMs - rangeStartMs) / rangeMs) * 100}
                            widthPct={((endMs - startMs) / rangeMs) * 100}
                            draggable={ev.type === 'queued' && isDraggable(ev.item)}
                            dimmed={settlingSince != null && ev.moved === true}
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
                  const hold = queueHold(item, t);
                  const reason = hold?.problem
                    ? hold.text
                    : entry.reason === 'waiting' && entry.detail
                      ? translateWaitingReason(entry.detail, t)
                      : label;
                  return (
                    <OffTimelineChip
                      key={item.id}
                      item={item}
                      reason={reason}
                      problem={!!hold?.problem}
                      // A job held off the lanes is not part of the plan.
                      draggable={false}
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
              <div className="rounded-md bg-bambu-dark-secondary shadow-lg" style={{ width: 200, height: barHeight }}>
                <div
                  className={`@container relative h-full rounded-md flex items-center gap-1.5 px-1.5 cursor-grabbing overflow-hidden ${
                    dragEvent ? barClasses(dragEvent) : 'bg-bambu-green/20 border border-bambu-green/50'
                  }`}
                >
                  <BarContent
                    ev={dragEvent ?? { item: dragItem, estimatedStart: now, estimatedEnd: now, type: 'queued' }}
                    t={t}
                    height={barHeight}
                  />
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        </BarHeightContext.Provider>
      )}

      {info && (
        <div
          ref={infoRef}
          role="status"
          className="fixed z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-xs text-white shadow-xl"
          style={{
            left: Math.max(16, Math.min(info.x - 144, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 16 - 288)),
            top: info.y + 12,
          }}
          data-testid="timeline-info"
        >
          {info.text}
        </div>
      )}
      {staffedOpen && (
        <StaffedHoursDialog
          canEdit={canEditStaffedHours}
          waitsForPlate={staffed?.waits_for_plate ?? false}
          awayUntil={awayUntilMs != null && awayUntilMs > nowMs ? shortTime(awayUntilMs) : null}
          present={presentUntilMs != null && presentUntilMs > nowMs}
          onClose={() => setStaffedOpen(false)}
          t={t}
        />
      )}
      {detailsItem && (
        <QueueJobDetails
          key={detailsItem.id}
          item={detailsItem}
          printers={printers}
          expected={detailsExpected}
          variant={detailsEvent?.variant ?? null}
          progress={detailsItem.status === 'printing' ? detailsEvent?.progress ?? null : null}
          heldReason={detailsHeld}
          pinChoices={detailsPinChoices}
          suggestedPrinterId={details?.suggestedPrinterId ?? null}
          canModify={mayModify(detailsItem)}
          reservation={detailsReservation && detailsHold
            ? {
                printer: printersById.get(detailsReservation.printer_id)?.name ?? `#${detailsReservation.printer_id}`,
                active: detailsReservation.active,
                kind: detailsHold.kind,
                byPlanner: detailsHold.byPlanner,
                expectedPrinter: detailsLane != null && detailsLane !== detailsReservation.printer_id
                  ? printersById.get(detailsLane)?.name ?? `#${detailsLane}`
                  : null,
              }
            : null}
          onReleaseReservation={onReleaseReservation && detailsReservation
            ? () => { setDetails(null); onReleaseReservation(detailsItem); }
            : undefined}
          onPin={onPinItem ? (target) => {
            onPinItem(detailsItem, target);
            setDetails(null);
          } : undefined}
          onEdit={onEditItem ? () => { setDetails(null); onEditItem(detailsItem); } : undefined}
          onCancel={onCancelItem ? () => { setDetails(null); onCancelItem(detailsItem); } : undefined}
          onStop={onStopItem ? () => { setDetails(null); onStopItem(detailsItem); } : undefined}
          onStart={onStartItem ? () => { setDetails(null); onStartItem(detailsItem); } : undefined}
          onClose={() => setDetails(null)}
          t={t}
        />
      )}
    </div>
  );
}
