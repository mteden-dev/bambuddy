/**
 * Fork (slot spools): which AMS slots the printer card lights up, and the
 * amount / margin helpers the slot dialog and the print dialog share.
 */
import { describe, it, expect } from 'vitest';
import {
  canLoadSlotRoll,
  parseGrams,
  rollGramsValid,
  slotHasRoll,
  slotSpoolAmountRequest,
  slotSpoolAmountValid,
  slotSpoolOutlineClass,
  slotSpoolRingClass,
  slotSpoolState,
  withFilamentMargin,
} from '../../utils/slotSpools';

const base = { enabled: true, hasAssignment: false, isBambuSpool: false, hasPrompt: false };

describe('slotHasRoll', () => {
  it('reads the presence bit first', () => {
    expect(slotHasRoll({ exists: true, tray_type: '' })).toBe(true);
    expect(slotHasRoll({ exists: false, tray_type: 'PLA' })).toBe(false);
  });

  it('falls back to a reported type without a bit', () => {
    expect(slotHasRoll({ tray_type: 'PLA' })).toBe(true);
    expect(slotHasRoll({ tray_type: '' })).toBe(false);
    expect(slotHasRoll(undefined)).toBe(false);
  });
});

describe('slotSpoolState', () => {
  it('lights a roll nothing counts as new', () => {
    expect(slotSpoolState({ ...base, tray: { exists: true, tray_type: '' } })).toBe('new');
  });

  it('leaves an empty slot dark', () => {
    expect(slotSpoolState({ ...base, tray: { exists: false } })).toBeNull();
  });

  it('leaves a Bambu RFID roll to the inventory', () => {
    expect(slotSpoolState({ ...base, isBambuSpool: true, tray: { exists: true, tray_type: 'PLA' } })).toBeNull();
  });

  it('leaves a counted slot dark unless it asks "same roll?"', () => {
    const tray = { exists: true, tray_type: 'PLA' };
    expect(slotSpoolState({ ...base, hasAssignment: true, tray })).toBeNull();
    expect(slotSpoolState({ ...base, hasAssignment: true, hasPrompt: true, tray })).toBe('check');
  });

  it('asks "same roll?" only while a roll is in the slot', () => {
    // A runout switched to the backup slot read as empty, full, empty: the
    // question was left on a slot showing "Empty".
    expect(slotSpoolState({ ...base, hasAssignment: true, hasPrompt: true, tray: { exists: false, tray_type: '' } })).toBeNull();
    expect(slotSpoolState({ ...base, hasAssignment: true, hasPrompt: true, tray: undefined })).toBeNull();
  });

  it('lights a used-up slot spool with a roll in it as new', () => {
    const tray = { exists: true, tray_type: 'PETG' };
    expect(slotSpoolState({ ...base, hasAssignment: true, slotSpoolLeft: 3, tray })).toBe('new');
    expect(slotSpoolState({ ...base, hasAssignment: true, slotSpoolLeft: -40, tray })).toBe('new');
    expect(slotSpoolState({ ...base, hasAssignment: true, slotSpoolLeft: 120, tray })).toBeNull();
    // Taken out and not back yet: nothing to set.
    expect(slotSpoolState({ ...base, hasAssignment: true, slotSpoolLeft: 0, tray: { exists: false } })).toBeNull();
    // "Same roll?" still wins over used up.
    expect(slotSpoolState({ ...base, hasAssignment: true, hasPrompt: true, slotSpoolLeft: 0, tray })).toBe('check');
  });

  it('lights nothing when disabled (Spoolman mode, no permission)', () => {
    expect(slotSpoolState({ ...base, enabled: false, tray: { exists: true } })).toBeNull();
  });

  it('lights nothing while the slot rows are not known', () => {
    // Loading, failed or not readable: "no spool" would offer to replace a counted roll.
    expect(slotSpoolState({ ...base, hasAssignment: null, tray: { exists: true, tray_type: 'PLA' } })).toBeNull();
    expect(slotSpoolState({ ...base, hasAssignment: null, hasPrompt: true, tray: { exists: true } })).toBeNull();
  });
});

describe('slot rings', () => {
  it('frames "same roll?" with an outline of its own, never the amber ring of the expected slot', () => {
    expect(slotSpoolRingClass('check')).toBe('');
    expect(slotSpoolOutlineClass('check')).toContain('outline-dashed');
    expect(slotSpoolOutlineClass('check')).not.toContain('amber');
    expect(slotSpoolRingClass('new')).toContain('ring-sky-400');
    expect(slotSpoolOutlineClass('new')).toBe('');
  });
});

describe('canLoadSlotRoll', () => {
  it('lets any roll but a Bambu RFID one be loaded by hand', () => {
    const tray = { exists: true, tray_type: 'PETG' };
    expect(canLoadSlotRoll({ enabled: true, isBambuSpool: false, tray })).toBe(true);
    expect(canLoadSlotRoll({ enabled: true, isBambuSpool: true, tray })).toBe(false);
    expect(canLoadSlotRoll({ enabled: true, isBambuSpool: false, tray: { exists: false } })).toBe(false);
    expect(canLoadSlotRoll({ enabled: false, isBambuSpool: false, tray })).toBe(false);
  });
});

describe('amounts', () => {
  it('a full roll is a kilogram', () => {
    expect(slotSpoolAmountRequest({ kind: 'full' })).toEqual({ remaining_grams: 1000, restore_spool_id: null });
  });

  it('another amount needs a believable number of grams', () => {
    expect(slotSpoolAmountValid({ kind: 'grams', grams: null })).toBe(false);
    expect(slotSpoolAmountValid({ kind: 'grams', grams: -1 })).toBe(false);
    // 0 g would be a used-up roll at once, lighting the slot "new" again.
    expect(slotSpoolAmountValid({ kind: 'grams', grams: 0 })).toBe(false);
    expect(slotSpoolAmountValid({ kind: 'grams', grams: 1 })).toBe(true);
    expect(slotSpoolAmountValid({ kind: 'grams', grams: 5000 })).toBe(true);
    // 6500 is a typo for 650.
    expect(slotSpoolAmountValid({ kind: 'grams', grams: 6500 })).toBe(false);
    expect(slotSpoolAmountRequest({ kind: 'grams', grams: 420 })).toEqual({ remaining_grams: 420, restore_spool_id: null });
  });

  it('reads grams typed with a decimal comma', () => {
    expect(parseGrams('650')).toBe(650);
    expect(parseGrams('412,5')).toBe(412.5);
    expect(parseGrams(' 412.5 ')).toBe(412.5);
    expect(parseGrams('')).toBeNull();
    expect(parseGrams('abc')).toBeNull();
    expect(parseGrams('1,2,3')).toBeNull();
    expect(rollGramsValid(parseGrams('0,5'))).toBe(false);
  });

  it('a restored roll needs a pick and keeps its own amount', () => {
    expect(slotSpoolAmountValid({ kind: 'restore', spoolId: null })).toBe(false);
    expect(slotSpoolAmountRequest({ kind: 'restore', spoolId: 7 })).toEqual({ remaining_grams: null, restore_spool_id: 7 });
  });
});

describe('withFilamentMargin', () => {
  it('adds the margin the dispatcher adds', () => {
    expect(withFilamentMargin(200, 5)).toBeCloseTo(210);
    expect(withFilamentMargin(200, 0)).toBe(200);
    expect(withFilamentMargin(200, undefined)).toBe(200);
    expect(withFilamentMargin(200, -10)).toBe(200);
    expect(withFilamentMargin(100, 500)).toBe(200);
  });
});
