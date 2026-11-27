/**
 * Fork (products): helpers for the Products tab that need no React.
 */
import type { QueryClient } from '@tanstack/react-query';
import type {
  Product,
  ProductJob,
  ProductOrder,
  ProductPart,
  ProductPlanResult,
  ProductPlateFile,
} from '../api/client';

/** Lower case without diacritics, so "Góra" matches a file named "gora_x2". */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Pieces per part (by index) a new plate probably prints, from its objects and
 * name: a product with one part takes all the plate's objects; otherwise the
 * part whose name is in the file's name does, and a plate naming several parts
 * with one object each prints one of each. Anything else starts at 0 for the
 * user to fill in.
 */
export function guessPlatePieces(parts: Pick<ProductPart, 'name'>[], file: ProductPlateFile): number[] {
  const objects = file.object_count && file.object_count > 0 ? file.object_count : 1;
  const pieces = parts.map(() => 0);
  if (parts.length === 1) {
    pieces[0] = objects;
    return pieces;
  }
  const text = foldText(`${file.print_name ?? ''} ${file.filename ?? ''}`);
  const named = parts
    .map((part, index) => ({ index, name: foldText(part.name.trim()) }))
    .filter(({ name }) => name.length >= 2 && text.includes(name))
    .map(({ index }) => index);
  if (named.length === 1) {
    pieces[named[0]] = objects;
  } else if (named.length > 1 && file.object_count === named.length) {
    for (const index of named) pieces[index] = 1;
  }
  return pieces;
}

/** "Lid ×1 · Base ×1 · Tray ×2" */
export function partsSummary(parts: Pick<ProductPart, 'name' | 'quantity'>[]): string {
  return parts.map((p) => `${p.name} ×${p.quantity}`).join(' · ');
}

/** The part's name by id, or "#id" for a part that is gone. */
export function partName(product: Pick<Product, 'parts'>, partId: number): string {
  return product.parts.find((p) => p.id === partId)?.name ?? `#${partId}`;
}

/** "2× Lid, 1× Tray" */
export function piecesText(product: Pick<Product, 'parts'>, pieces: { part_id: number; pieces: number }[]): string {
  return pieces.map((p) => `${p.pieces}× ${partName(product, p.part_id)}`).join(', ');
}

/** What to tell the user about a plan: the toast's key and its values. */
export function planSummary(result: ProductPlanResult): {
  key: 'products.toast.planned' | 'products.toast.replanned' | 'products.toast.nothingToPrint';
  values: Record<string, number>;
} {
  if (result.planned_jobs === 0) return { key: 'products.toast.nothingToPrint', values: {} };
  if (result.replaced > 0 || result.kept > 0) {
    return {
      key: 'products.toast.replanned',
      values: { n: result.planned_jobs, kept: result.kept, replaced: result.replaced },
    };
  }
  return { key: 'products.toast.planned', values: { n: result.planned_jobs } };
}

/**
 * The Base order a product order comes from, else null. Such an order is
 * changed in Base (the next read would undo a change here), so it is read-only.
 */
export function baseOrderIdOf(order: Pick<ProductOrder, 'base_order_id' | 'external_source' | 'external_ref'>): number | null {
  if (order.base_order_id != null) return order.base_order_id;
  if (order.external_source !== 'base') return null;
  // external_ref is "<Base order id>/<product id>".
  const id = Number((order.external_ref ?? '').split('/')[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Sent by the app after any plan (websocket): detail.product_ids. */
export const PRODUCTS_REPLANNED_EVENT = 'bambuddy:products-replanned';

/**
 * Everything a plan can change: one product's plan may replan others that
 * share its printers, so every product, every Base order and the queue (with
 * its forecast, under ['queue', ...]) are read again.
 */
export function invalidatePlanQueries(queryClient: QueryClient): void {
  for (const key of ['products', 'product', 'base-sync', 'queue']) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** A plate's time: what the plan counts on, and the slicer's when that comes from print history. */
export function plateTime(plate: {
  print_time_seconds?: number | null;
  planned_seconds?: number | null;
  learned?: boolean;
}): { seconds: number | null; slicer: number | null } {
  const slicer = plate.print_time_seconds ?? null;
  const planned = plate.planned_seconds ?? slicer;
  return { seconds: planned || null, slicer: plate.learned && slicer ? slicer : null };
}

/** Identical queued plates (same plate, printer and state) as one row with a count, in the list's order. */
export function groupJobs(jobs: ProductJob[]): { job: ProductJob; count: number }[] {
  const groups: { key: string; job: ProductJob; count: number }[] = [];
  for (const job of jobs) {
    const key = [
      job.product_plate_id ?? `f:${job.filename}`,
      job.printer_id ?? '-',
      job.status,
      job.pinned,
      job.by_hand,
      job.moved,
      job.counted !== false,
      JSON.stringify(job.pieces),
    ].join('|');
    const found = groups.find((g) => g.key === key);
    if (found) found.count += 1;
    else groups.push({ key, job, count: 1 });
  }
  return groups.map(({ job, count }) => ({ job, count }));
}
