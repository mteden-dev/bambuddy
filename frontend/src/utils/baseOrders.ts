import type { BaseOrder, BaseOrderLine, ProductJobOrders, ProductOrderTag } from '../api/client';
import { formatDateTime, formatTimeOnly, parseUTCDate } from './date';
import type { TimeFormat } from './date';

/** Products an order's mapped lines want: product id -> units. A line someone has already wants none. */
export function wantedUnits(order: BaseOrder): Map<number, number> {
  const wanted = new Map<number, number>();
  for (const line of order.lines) {
    if (line.mapping === 'product' && line.product_id != null && !line.have) {
      wanted.set(line.product_id, (wanted.get(line.product_id) ?? 0) + line.quantity * line.units);
    }
  }
  return wanted;
}

/** Lines that are no product (not even "not printed") and nobody has yet: they keep an order from ready. */
export function openLines(order: BaseOrder): BaseOrderLine[] {
  return order.lines.filter((line) => line.mapping === 'unmapped' && !line.have);
}

/** Nothing to make for the order: its draft leaves nothing to print, or every line is had or not printed. */
export function nothingToMake(order: BaseOrder): boolean {
  if (order.draft) return order.draft.nothing_to_print;
  return order.lines.some((line) => line.have) && order.lines.every((line) => line.have || line.mapping === 'not_printed');
}

/** What sending a waiting order does: print it all, print what the shelf leaves, or nothing to print. */
export function sendLabel(order: BaseOrder): string {
  if (nothingToMake(order)) return 'baseSync.markReady';
  return order.draft ? 'baseSync.printRest' : 'baseSync.print';
}

/** Whole local days from today to a date (negative: past); null without one. */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  const date = parseUTCDate(iso ?? null);
  if (!date) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

/** How urgent a ship-by date is. */
export type ShipKind = 'late' | 'today' | 'tomorrow' | 'dayAfter' | 'later';

export function shipKind(iso: string | null | undefined, now: Date = new Date()): ShipKind | null {
  const date = parseUTCDate(iso ?? null);
  if (!date) return null;
  if (date.getTime() < now.getTime()) return 'late';
  const days = daysUntil(iso, now) ?? 0;
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : days === 2 ? 'dayAfter' : 'later';
}

/** The section an order is listed under: the order it is to be made in. */
export type OrderSection = 'today' | 'tomorrow' | 'dayAfter' | 'later' | 'allegroNoDate' | 'shop';

export const SECTION_ORDER: OrderSection[] = ['today', 'tomorrow', 'dayAfter', 'later', 'allegroNoDate', 'shop'];

export function sectionOf(order: BaseOrder, now: Date = new Date()): OrderSection {
  if (order.source_kind !== 'allegro') return 'shop';
  const kind = shipKind(order.ship_by, now);
  if (kind === null) return 'allegroNoDate';
  return kind === 'late' ? 'today' : kind;
}

/** Whether an order matches a search: its label, nick, numbers, SKUs or product names. */
export function matchesSearch(order: BaseOrder, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    order.label,
    order.buyer_login ?? '',
    order.number ?? '',
    String(order.order_id),
    ...order.lines.flatMap((line) => [line.sku, line.name, line.product_name ?? '']),
  ];
  return fields.some((field) => field.toLowerCase().includes(q));
}

/** A job's orders, the most urgent first (ship-by date, else due date). */
export function urgentFirst(entry: ProductJobOrders | undefined): ProductOrderTag[] {
  const when = (tag: ProductOrderTag) => parseUTCDate(tag.ship_by ?? tag.due)?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...(entry?.orders ?? [])].sort((a, b) => when(a) - when(b));
}

/** Pieces an order in production misses: neither there nor coming from the queue (its print left it). */
export function missingParts(order: BaseOrder): { name: string; pieces: number }[] {
  if (order.state !== 'accepted' || order.ready) return [];
  return order.progress.flatMap((product) =>
    product.parts.filter((part) => (part.missing ?? 0) > 0).map((part) => ({ name: part.name, pieces: part.missing })),
  );
}

/**
 * The orders table's columns: on from xl (a MacBook), below it (every iPad) a
 * card. The actions column has a fixed width in the rows and in the heading
 * row alike, so headings line up with the cells. A literal for Tailwind.
 */
export const ORDER_GRID = 'xl:grid-cols-[104px_200px_minmax(0,1fr)_230px_240px]';

/** A time today as "14:10", another day with its weekday ("Thu 08:10"). */
export function shortWhen(value: string | null | undefined, timeFormat: TimeFormat, now: Date = new Date()): string {
  const date = parseUTCDate(value);
  if (!date) return '';
  if (date.toDateString() === now.toDateString()) return formatTimeOnly(date, timeFormat);
  return formatDateTime(value ?? null, timeFormat, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** An estimate after its deadline (ship-by or due date). */
export function isLate(estimate: string | null | undefined, deadline: string | null | undefined): boolean {
  const ready = parseUTCDate(estimate);
  const due = parseUTCDate(deadline);
  return !!ready && !!due && ready.getTime() > due.getTime();
}

/** An order in production expected after its ship-by date (any of its products). */
export function orderLate(order: BaseOrder): boolean {
  if (order.state !== 'accepted' || order.ready || order.packed) return false;
  return order.progress.some((p) => isLate(p.estimated_ready_at, order.ship_by));
}

/** "jan_k", "jan_k +1", or the stock label for a plate printed for no order; null for none. */
export function jobOrdersText(entry: ProductJobOrders | undefined, stockLabel: string): string | null {
  if (!entry) return null;
  const orders = urgentFirst(entry);
  if (!orders.length) return entry.for_stock ? stockLabel : null;
  return orders.length > 1 ? `${orders[0].label} +${orders.length - 1}` : orders[0].label;
}
