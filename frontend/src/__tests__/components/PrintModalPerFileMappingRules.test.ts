/**
 * Rules behind the per-file mapping panels of separate jobs on one printer:
 * which picks belong to which print, when a file carries a mapping at all, and
 * when a pick swaps the material.
 */

import { describe, it, expect } from 'vitest';
import type { LoadedFilament } from '../../hooks/useFilamentMapping';
import {
  mappingSwapsMaterial,
  perFileAmsMapping,
  perFileMappingKey,
} from '../../components/PrintModal/perFileMapping';
import type { FilamentReqsData } from '../../components/PrintModal/types';

const tray = (globalTrayId: number, type: string, color: string): LoadedFilament => ({
  type,
  color,
  colorName: color,
  amsId: 0,
  trayId: globalTrayId,
  isHt: false,
  isExternal: false,
  label: `A${globalTrayId + 1}`,
  globalTrayId,
  trayInfoIdx: '',
  remain: -1,
});

const LOADED = [tray(0, 'PLA', '#FFFFFF'), tray(1, 'PLA', '#FF0000'), tray(2, 'PETG', '#0000FF')];

const reqs = (...filaments: Array<{ slot_id: number; type: string; color: string }>): FilamentReqsData =>
  ({ filaments: filaments.map((f) => ({ ...f, used_grams: 10, used_meters: 3 })) }) as FilamentReqsData;

describe('perFileMappingKey', () => {
  it('tells printers, files and plates apart', () => {
    const keys = new Set([
      perFileMappingKey(1, 11, null),
      perFileMappingKey(2, 11, null),
      perFileMappingKey(1, 12, null),
      perFileMappingKey(1, 11, 1),
      perFileMappingKey(1, 11, 3),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('perFileAmsMapping', () => {
  const twoSlots = reqs({ slot_id: 1, type: 'PLA', color: '#000000' }, { slot_id: 2, type: 'PLA', color: '#FFFFFF' });

  it('leaves a file nobody changed to the scheduler', () => {
    expect(perFileAmsMapping(twoSlots, LOADED, undefined)).toBeUndefined();
    expect(perFileAmsMapping(twoSlots, LOADED, {})).toBeUndefined();
  });

  it('sends the pick and the panel’s own match for the other slots', () => {
    // Slot 1 picked onto the red spool; slot 2 still matched exactly (white).
    expect(perFileAmsMapping(twoSlots, LOADED, { 1: 1 })).toEqual([1, 0]);
  });

  it('sends nothing while the printer’s trays are unknown (#2589)', () => {
    expect(perFileAmsMapping(twoSlots, [], { 1: 1 })).toBeUndefined();
  });

  it('sends nothing for a file whose filaments are not known', () => {
    expect(perFileAmsMapping(undefined, LOADED, { 1: 1 })).toBeUndefined();
    expect(perFileAmsMapping(reqs(), LOADED, { 1: 1 })).toBeUndefined();
  });
});

describe('mappingSwapsMaterial', () => {
  const pla = reqs({ slot_id: 1, type: 'PLA', color: '#000000' });

  it('is set by a slot on a tray of another material', () => {
    expect(mappingSwapsMaterial(pla, [2], LOADED)).toBe(true);
  });

  it('is not set by another colour of the same material', () => {
    expect(mappingSwapsMaterial(pla, [1], LOADED)).toBe(false);
  });

  it('ignores unresolved slots and trays it cannot see', () => {
    expect(mappingSwapsMaterial(pla, [-1], LOADED)).toBe(false);
    expect(mappingSwapsMaterial(pla, [9], LOADED)).toBe(false);
    expect(mappingSwapsMaterial(pla, undefined, LOADED)).toBe(false);
  });
});
