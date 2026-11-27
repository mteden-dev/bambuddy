/**
 * Slot spools (fork): a roll counted per AMS slot without naming it.
 *
 * The backend (services/slot_spools.py) keeps a `slot_quick` spool assigned to
 * the slot and archives it when the roll comes out. Here: which slots the
 * printer card should light up.
 *
 * - "new": a roll is in the slot and the slot has no spool at all, so nothing
 *   counts what it uses. Bambu RFID rolls are left out: the inventory adds
 *   those by their tag.
 * - "new" too: the slot's slot spool is used up and a roll is in the slot. The
 *   backend only notices a swap when it sees the slot empty, and a restart (a
 *   redeploy) or a quick swap can hide that; a used-up roll still in the slot
 *   is the case that matters.
 * - "check": the slot was emptied and refilled under its slot spool, and the
 *   printer cannot tell the same roll from another; the backend asks. Only
 *   while a roll is in the slot: a runout switched over by AMS Filament Backup
 *   can read as empty, full, empty, and there is nothing to ask about then.
 *
 * Whatever lights up, a slot with a roll in it can always be given a new roll
 * by hand (`canLoadSlotRoll`), so a missed swap never leaves it stuck.
 *
 * Nothing lights while the slot's assignment is not known (the assignments
 * still loading, failed, or not readable for this user): "no spool" read from
 * a missing list would offer to replace a roll that is being counted.
 */

export type SlotSpoolState = 'new' | 'check' | null;

/** The kilogram roll "full" stands for. */
export const FULL_ROLL_GRAMS = 1000;

/** The data_origin of a spool made for a slot. */
export const SLOT_SPOOL_ORIGIN = 'slot_quick';

/** A slot spool with this little left is used up (the backend's RESTORABLE_MIN_GRAMS). */
export const USED_UP_GRAMS = 5;

/** The most a roll may hold (the backend's MAX_SLOT_SPOOL_GRAMS): 6500 is a typo for 650. */
export const MAX_ROLL_GRAMS = 5000;

/**
 * Grams typed by hand, a decimal comma included (a Polish keyboard types one);
 * null when blank or not a number.
 */
export function parseGrams(text: string): number | null {
  const cleaned = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Is this a believable amount of filament on a roll going into a slot (1 g to 5 kg)? */
export function rollGramsValid(grams: number | null | undefined): grams is number {
  return grams != null && Number.isFinite(grams) && grams >= 1 && grams <= MAX_ROLL_GRAMS;
}

/** Grams left on a spool, by its label and what the prints used. */
export function spoolGramsLeft(spool: { label_weight?: number | null; weight_used?: number | null }): number {
  return (spool.label_weight || FULL_ROLL_GRAMS) - (spool.weight_used ?? 0);
}

interface TrayPresence {
  tray_type?: string | null;
  exists?: boolean | null;
}

/** Is a roll in the slot? The presence bit when the firmware sends one, else a reported type. */
export function slotHasRoll(tray: TrayPresence | null | undefined): boolean {
  if (!tray) return false;
  if (tray.exists === true) return true;
  if (tray.exists === false) return false;
  return !!tray.tray_type;
}

export function slotSpoolState({
  enabled,
  tray,
  hasAssignment,
  isBambuSpool,
  hasPrompt,
  slotSpoolLeft = null,
}: {
  /** Built-in inventory mode and the user may change it. */
  enabled: boolean;
  tray: TrayPresence | null | undefined;
  /** Whether the slot holds a spool; null while that is not known. */
  hasAssignment: boolean | null;
  isBambuSpool: boolean;
  hasPrompt: boolean;
  /** Grams left on the slot's slot spool; null when the slot holds none. */
  slotSpoolLeft?: number | null;
}): SlotSpoolState {
  if (!enabled || hasAssignment === null) return null;
  if (hasAssignment) {
    if (hasPrompt && slotHasRoll(tray)) return 'check';
    if (slotSpoolLeft != null && slotSpoolLeft <= USED_UP_GRAMS && !isBambuSpool && slotHasRoll(tray)) return 'new';
    return null;
  }
  if (isBambuSpool) return null;
  return slotHasRoll(tray) ? 'new' : null;
}

/** Can the user load a new roll into this slot by hand? Any roll the inventory does not add by its tag. */
export function canLoadSlotRoll({
  enabled,
  tray,
  isBambuSpool,
}: {
  enabled: boolean;
  tray: TrayPresence | null | undefined;
  isBambuSpool: boolean;
}): boolean {
  return enabled && !isBambuSpool && slotHasRoll(tray);
}

/**
 * Ring drawn around a slot with a new roll on the printer card. The card puts
 * the expected, ran-out and active rings ahead of it, so it may not show.
 */
export function slotSpoolRingClass(state: SlotSpoolState): string {
  if (state === 'new') return 'ring-2 ring-sky-400 ring-offset-1 ring-offset-bambu-dark animate-pulse';
  return '';
}

/**
 * Frame drawn around a slot asking "same roll?". An outline, not a ring, so it
 * shows next to whatever ring the slot has (the documented case is the active
 * slot: a roll added after a runout during a print), and dashed violet, since
 * amber already means "the slot the paused print expects".
 */
export function slotSpoolOutlineClass(state: SlotSpoolState): string {
  if (state === 'check') return 'outline-2 outline-dashed outline-offset-2 outline-fuchsia-400';
  return '';
}

export type SlotSpoolAmount =
  | { kind: 'full' }
  | { kind: 'grams'; grams: number | null }
  | { kind: 'restore'; spoolId: number | null };

/** Can the dialog save with this amount? */
export function slotSpoolAmountValid(amount: SlotSpoolAmount): boolean {
  if (amount.kind === 'grams') return rollGramsValid(amount.grams);
  if (amount.kind === 'restore') return amount.spoolId != null;
  return true;
}

/** The request fields an amount stands for. */
export function slotSpoolAmountRequest(amount: SlotSpoolAmount): {
  remaining_grams: number | null;
  restore_spool_id: number | null;
} {
  if (amount.kind === 'grams') return { remaining_grams: amount.grams, restore_spool_id: null };
  if (amount.kind === 'restore') return { remaining_grams: null, restore_spool_id: amount.spoolId };
  return { remaining_grams: FULL_ROLL_GRAMS, restore_spool_id: null };
}

/** Grams to add to a print's demand, as the dispatcher does (`filament_check_margin_pct`). */
export function withFilamentMargin(grams: number, marginPct: number | null | undefined): number {
  const pct = Number.isFinite(marginPct) && (marginPct as number) > 0 ? Math.min(marginPct as number, 100) : 0;
  return grams * (1 + pct / 100);
}
