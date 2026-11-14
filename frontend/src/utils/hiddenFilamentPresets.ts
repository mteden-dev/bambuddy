// Filament presets the AMS slot picker leaves out.
//
// Stored as the ``hidden_filament_presets`` setting: a JSON array of the
// picker's own preset IDs (a Bambu Cloud setting_id, ``local_<id>``,
// ``orca_<id>`` or ``builtin_<filament_id>``). Hiding only filters the list;
// nothing is deleted from Bambu Cloud, Orca Cloud or the local profiles.

/** The hidden IDs from the stored setting. A missing or unreadable value hides nothing. */
export function parseHiddenFilamentPresets(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set();
  }
}

/** The setting value for ``ids``, sorted so the same set always stores the same text. */
export function serializeHiddenFilamentPresets(ids: Iterable<string>): string {
  return JSON.stringify([...new Set(ids)].sort());
}

/** ``hidden`` with ``id`` added, or removed when it is already there. */
export function toggleHiddenFilamentPreset(hidden: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
