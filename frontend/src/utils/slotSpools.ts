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
 */

export type SlotSpoolState = 'new' | 'check' | null;

/** The kilogram roll "full" stands for. */
export const FULL_ROLL_GRAMS = 1000;

/** The data_origin of a spool made for a slot. */
export const SLOT_SPOOL_ORIGIN = 'slot_quick';

/** A slot spool with this little left is used up (the backend's RESTORABLE_MIN_GRAMS). */
export const USED_UP_GRAMS = 5;

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
  hasAssignment: boolean;
  isBambuSpool: boolean;
  hasPrompt: boolean;
  /** Grams left on the slot's slot spool; null when the slot holds none. */
  slotSpoolLeft?: number | null;
}): SlotSpoolState {
  if (!enabled) return null;
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

/** Ring drawn around a lit slot on the printer card. */
export function slotSpoolRingClass(state: SlotSpoolState): string {
  if (state === 'new') return 'ring-2 ring-sky-400 ring-offset-1 ring-offset-bambu-dark animate-pulse';
  if (state === 'check') return 'ring-2 ring-amber-400 ring-offset-1 ring-offset-bambu-dark animate-pulse';
  return '';
}

export type SlotSpoolAmount =
  | { kind: 'full' }
  | { kind: 'grams'; grams: number | null }
  | { kind: 'restore'; spoolId: number | null };

/** Can the dialog save with this amount? */
export function slotSpoolAmountValid(amount: SlotSpoolAmount): boolean {
  if (amount.kind === 'grams') return amount.grams != null && Number.isFinite(amount.grams) && amount.grams >= 0;
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
