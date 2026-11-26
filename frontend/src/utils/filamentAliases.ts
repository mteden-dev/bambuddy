/**
 * Fork (filament aliases): colours and filament profiles marked as the same.
 *
 * Mirrors backend services/filament_aliases.py, so the hints the UI gives
 * (which queue jobs a printer can take, whether a slot's colour matches) agree
 * with what the queue does. Filled by useFilamentAliasesSync in Layout; an
 * empty store changes nothing.
 */

export interface FilamentAliasGroups {
  /** Groups of 6-digit lowercase hex colours, no '#'. */
  colors: string[][];
  /** Groups of filament profiles (tray_info_idx). */
  presets: string[][];
}

let colorGroupOf = new Map<string, string[]>();
let presetGroupOf = new Map<string, string[]>();
let version = 0;
const listeners = new Set<() => void>();

function index(groups: string[][] | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const group of groups ?? []) {
    if (group.length < 2) continue;
    for (const member of group) result.set(member, group);
  }
  return result;
}

/** Use these groups for matching (none: nothing is merged). */
export function setFilamentAliases(groups: FilamentAliasGroups | null | undefined): void {
  colorGroupOf = index(groups?.colors?.map((g) => g.map((c) => c.replace('#', '').toLowerCase().slice(0, 6))));
  presetGroupOf = index(groups?.presets?.map((g) => g.map((p) => p.trim())));
  version += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeFilamentAliases(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFilamentAliasesVersion(): number {
  return version;
}

/** The colour a compare-normalised colour stands for: its group's first member, or itself. */
export function aliasColor(normalized: string): string {
  return colorGroupOf.get(normalized)?.[0] ?? normalized;
}

/** The profile a tray_info_idx stands for: its group's first member, or itself. */
export function aliasPreset(idx: string | null | undefined): string {
  const text = (idx ?? '').trim();
  return presetGroupOf.get(text)?.[0] ?? text;
}

/** Every colour that counts as this compare-normalised one (itself included). */
export function colorAliases(normalized: string): string[] {
  return colorGroupOf.get(normalized) ?? [normalized];
}

/** Every profile that counts as this one (itself included). */
export function presetAliases(idx: string): string[] {
  return presetGroupOf.get(idx.trim()) ?? [idx];
}
