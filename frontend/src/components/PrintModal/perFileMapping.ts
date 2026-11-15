import {
  buildAmsMapping,
  buildFilamentComparison,
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
