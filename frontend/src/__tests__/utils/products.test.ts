/**
 * Fork (products): helpers of the Products tab.
 */
import { describe, expect, it } from 'vitest';
import type { ProductPlanResult, ProductPlateFile } from '../../api/client';
import { foldText, guessPlatePieces, partsSummary, piecesText, planSummary } from '../../utils/products';

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
  const result = (planned: number, replaced: number) => ({ planned_jobs: planned, replaced }) as ProductPlanResult;

  it('says what the plan did', () => {
    expect(planSummary(result(0, 2)).key).toBe('products.toast.nothingToPrint');
    expect(planSummary(result(3, 0))).toEqual({ key: 'products.toast.planned', values: { n: 3 } });
    expect(planSummary(result(3, 6))).toEqual({ key: 'products.toast.replanned', values: { n: 3, replaced: 6 } });
  });
});
