import {
  buildAmsMapping,
  buildFilamentComparison,
  type FilamentComparison,
  type LoadedFilament,
} from '../../hooks/useFilamentMapping';
import { filamentTypesCompatible } from '../../utils/amsHelpers';
import type { FilamentReqsData } from './types';

/**
 * Tray picks for separate jobs on one printer: each listed file gets its own
 * mapping panel, since each prints its own slots.
 *
 * Picks are kept per printer, file and plate. A global tray id names a spool
 * on one printer only, and slot 2 of plate 1 is another print than slot 2 of
 * plate 3, so a pick made for one of them must never be read for another.
 * Keying them this way, instead of clearing them whenever the printer or a
 * plate changes, also lets a reopened run start from the picks it was
 * submitted with.
 */
export function perFileMappingKey(printerId: number, fileId: number, plateId: number | null): string {
  return `${printerId}:${fileId}:${plateId ?? ''}`;
}

/**
 * The AMS mapping a separate job carries, or undefined to leave it to the
 * scheduler.
 *
 * Only a file whose panel the user changed sends one: everything the user
 * picked, and the panel's own match for the other slots, which is what the
 * panel showed next to the picks. A file left alone sends none, as before
 * these panels existed, and the scheduler matches its trays at dispatch: the
 * jobs of one run can start hours apart, and spools changed in between are
 * then still taken into account.
 *
 * Nothing either while the printer's trays are unknown: matched against none,
 * every slot would come out -1 (#2589).
 */
export function perFileAmsMapping(
  reqs: FilamentReqsData | undefined,
  loaded: LoadedFilament[],
  picks: Record<number, number> | undefined,
  preferLowest?: boolean,
  inventoryByTrayId?: Map<number, number>,
  ftsActive = false,
): number[] | undefined {
  if (!reqs?.filaments?.length || !picks || Object.keys(picks).length === 0 || loaded.length === 0) {
    return undefined;
  }
  return buildAmsMapping(buildFilamentComparison(reqs, loaded, picks, preferLowest, inventoryByTrayId, ftsActive));
}

/** A forced filament override, as the queue item's `filament_overrides` holds it. */
export interface ForcedPick {
  slot_id: number;
  type: string;
  color: string;
  color_name: string;
  tray_info_idx?: string;
  force_color_match: true;
}

/**
 * The trays picked by hand in a file's panel, as forced filament overrides
 * (fork): "this slot prints the filament in that tray", type and colour.
 *
 * A separate job may start hours after the run was queued, when the tray
 * picked may hold another spool. Sent as a bare tray with
 * `skip_filament_check`, it would print whatever is loaded there by then. With
 * the tray's filament forced, the scheduler keeps the tray while it still
 * holds that filament, finds another tray that does, or holds the job until
 * one does (print_scheduler._stored_mapping_conflict). It also no longer reads
 * a pick of another material as a mapping meant for another printer, since
 * the override is what the slot asks for. A pick whose tray can't be read now
 * is left out: the mapping still carries it.
 */
export function perFileForcedOverrides(
  reqs: FilamentReqsData | undefined,
  loaded: LoadedFilament[],
  picks: Record<number, number> | undefined,
  colorName: (filament: LoadedFilament) => string = (f) => f.colorName,
): ForcedPick[] | undefined {
  if (!reqs?.filaments?.length || !picks) return undefined;
  const out: ForcedPick[] = [];
  for (const req of reqs.filaments) {
    const slotId = req.slot_id ?? 0;
    const tray = slotId > 0 ? picks[slotId] : undefined;
    if (tray == null) continue;
    const filament = loaded.find((f) => f.globalTrayId === tray);
    if (!filament?.type || !filament.color) continue;
    out.push({
      slot_id: slotId,
      type: filament.type,
      color: filament.color,
      color_name: colorName(filament),
      ...(filament.trayInfoIdx ? { tray_info_idx: filament.trayInfoIdx } : {}),
      force_color_match: true,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Whether `mapping` sends a slot to a tray of another material (#2799), the
 * same rule as the single-file dialog: only a pick can do that, and the
 * scheduler would take it for a mapping meant for another printer and replace
 * it, unless the item says the user chose it (`skip_filament_check`). A tray
 * or requirement with no type is not judged.
 */
export function mappingSwapsMaterial(
  reqs: FilamentReqsData | undefined,
  mapping: number[] | undefined,
  loaded: LoadedFilament[],
): boolean {
  if (!mapping || !reqs?.filaments) return false;
  return reqs.filaments.some((req) => {
    const slotId = req.slot_id ?? 0;
    const tray = slotId > 0 ? mapping[slotId - 1] : undefined;
    if (tray == null || tray < 0) return false;
    const filament = loaded.find((f) => f.globalTrayId === tray);
    return !!filament?.type && !!req.type && !filamentTypesCompatible(filament.type, req.type);
  });
}

/**
 * The rows a job would wait for with "always require the file's colours" on
 * (fork, services/file_colors): matched to a tray of the right type in
 * another colour. The scheduler writes the file's colour into the job as a
 * forced override, rejects that tray at start, finds none in the colour and
 * holds the job until someone loads it. Rows in `exempt` are left out: a slot
 * that already carries its tray's filament as a forced override (a hand pick
 * sent that way) asks for what the tray holds and starts.
 */
export function rowsWaitingForColor(
  comparison: FilamentComparison[],
  exempt: ReadonlySet<number> = new Set(),
): FilamentComparison[] {
  return comparison.filter((row) => row.status === 'type_only' && !exempt.has(row.slot_id ?? 0));
}
