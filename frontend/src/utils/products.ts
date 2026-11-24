/**
 * Fork (products): helpers for the Products tab that need no React.
 */
import type { Product, ProductPart, ProductPlanResult, ProductPlateFile } from '../api/client';

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
  if (result.replaced > 0) {
    return { key: 'products.toast.replanned', values: { n: result.planned_jobs, replaced: result.replaced } };
  }
  return { key: 'products.toast.planned', values: { n: result.planned_jobs } };
}
