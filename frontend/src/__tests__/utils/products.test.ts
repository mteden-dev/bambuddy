/**
 * Fork (products): helpers of the Products tab.
 */
import { describe, expect, it } from 'vitest';
import type { ProductJob, ProductPlanResult, ProductPlateFile } from '../../api/client';
import {
  baseOrderIdOf,
  foldText,
  groupJobs,
  guessPlatePieces,
  partsSummary,
  piecesText,
  planSummary,
  plateTime,
} from '../../utils/products';
import { isLate, shortWhen } from '../../utils/baseOrders';
import { formatDateTime } from '../../utils/date';

const PARTS = [{ name: 'Góra' }, { name: 'Dół' }, { name: 'Tray' }];

function file(filename: string, objectCount: number | null, printName: string | null = null): ProductPlateFile {
  return {
    library_file_id: 1,
    filename,
    print_name: printName,
    model: 'P1S',
    print_time_seconds: 3600,
    filament_grams: 20,
    object_count: objectCount,
    has_thumbnail: false,
    missing: false,
  };
}

describe('foldText', () => {
  it('drops case and Polish diacritics', () => {
    expect(foldText('Góra Dół Łącznik')).toBe('gora dol lacznik');
  });
});

describe('guessPlatePieces', () => {
  it('gives a one-part product all of the plate objects', () => {
    expect(guessPlatePieces([{ name: 'Clip' }], file('anything.gcode.3mf', 4))).toEqual([4]);
  });

  it('gives the objects to the part named in the file, without diacritics', () => {
    expect(guessPlatePieces(PARTS, file('9mm_gora_x3.gcode.3mf', 3))).toEqual([3, 0, 0]);
    expect(guessPlatePieces(PARTS, file('box.gcode.3mf', 2, '9mm dół'))).toEqual([0, 2, 0]);
  });

  it('reads a plate naming several parts with one object each as one of each', () => {
    expect(guessPlatePieces(PARTS, file('22lr_gora_dol_tray.gcode.3mf', 3))).toEqual([1, 1, 1]);
  });

  it('leaves the pieces for the user when the name does not tell', () => {
    expect(guessPlatePieces(PARTS, file('plate_1.gcode.3mf', 3))).toEqual([0, 0, 0]);
    expect(guessPlatePieces(PARTS, file('gora_dol.gcode.3mf', 4))).toEqual([0, 0, 0]);
  });
});

describe('text helpers', () => {
  const product = {
    parts: [
      { id: 1, name: 'Lid', quantity: 1, matched: true },
      { id: 2, name: 'Tray', quantity: 2, matched: false },
    ],
  };

  it('summarises the parts and pieces', () => {
    expect(partsSummary(product.parts)).toBe('Lid ×1 · Tray ×2');
    expect(piecesText(product, [{ part_id: 2, pieces: 3 }, { part_id: 9, pieces: 1 }])).toBe('3× Tray, 1× #9');
  });
});

describe('planSummary', () => {
  const result = (planned: number, kept: number, replaced: number) =>
    ({ planned_jobs: planned, kept, replaced }) as ProductPlanResult;

  it('says what the plan did', () => {
    expect(planSummary(result(0, 0, 2)).key).toBe('products.toast.nothingToPrint');
    expect(planSummary(result(3, 0, 0))).toEqual({ key: 'products.toast.planned', values: { n: 3 } });
    expect(planSummary(result(3, 2, 6))).toEqual({
      key: 'products.toast.replanned',
      values: { n: 3, kept: 2, replaced: 6 },
    });
  });
});

// Fork (UI fixes)
describe('order and plate helpers', () => {
  it('finds the Base order of a product order', () => {
    expect(baseOrderIdOf({ base_order_id: 9, external_source: 'base', external_ref: '1/2' })).toBe(9);
    expect(baseOrderIdOf({ external_source: 'base', external_ref: '7001/4' })).toBe(7001);
    expect(baseOrderIdOf({ base_order_id: null, external_source: null, external_ref: null })).toBeNull();
  });

  it('gives the planned time, and the slicer\'s only when the plan learnt another', () => {
    expect(plateTime({ print_time_seconds: 7800, planned_seconds: 9600, learned: true })).toEqual({ seconds: 9600, slicer: 7800 });
    expect(plateTime({ print_time_seconds: 7800, planned_seconds: 7800, learned: false })).toEqual({ seconds: 7800, slicer: null });
    // Before the backend sends it: the slicer's time.
    expect(plateTime({ print_time_seconds: 3600 })).toEqual({ seconds: 3600, slicer: null });
  });

  it('groups identical plates on one printer, keeping the list order', () => {
    const job = (id: number, printer: number | null): ProductJob => ({
      id, queue_item_id: id * 10, status: 'planned', printer_id: printer, printer_name: null, pinned: false,
      pieces: [{ part_id: 1, pieces: 1 }], product_plate_id: 5, filename: 'a.3mf', print_time_seconds: 60,
      by_hand: false, moved: false,
    });
    const groups = groupJobs([job(1, 7), job(2, 8), job(3, 7), job(4, 7)]);
    expect(groups.map((g) => [g.job.id, g.count])).toEqual([[1, 3], [2, 1]]);
  });

  it('says a time today without the day, another day with its weekday', () => {
    const now = new Date();
    const today = new Date(now);
    today.setHours(23, 59, 0, 0);
    expect(shortWhen(today.toISOString(), '24h', now)).not.toMatch(/\s.*\s/);
    const later = new Date(now);
    later.setDate(later.getDate() + 2);
    expect(shortWhen(later.toISOString(), '24h', now)).toBe(
      formatDateTime(later.toISOString(), '24h', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('is late only when the estimate is after the deadline', () => {
    expect(isLate('2026-11-25T10:00:00Z', '2026-11-25T09:00:00Z')).toBe(true);
    expect(isLate('2026-11-25T08:00:00Z', '2026-11-25T09:00:00Z')).toBe(false);
    expect(isLate(null, '2026-11-25T09:00:00Z')).toBe(false);
    expect(isLate('2026-11-25T08:00:00Z', null)).toBe(false);
  });
});
