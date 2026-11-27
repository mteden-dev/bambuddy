// The AMS slot picker's quick colours.
//
// Stored as the ``ams_color_palette`` setting: a JSON array of
// {name, hex (RRGGBB), hidden?} in display order. Hidden colours sit behind
// the picker's "more colours" button. An empty value is the built-in palette
// below, so an install that never edits it keeps following the defaults.

export interface PaletteColor {
  name: string;
  /** Six upper-case hex digits, no ``#``. */
  hex: string;
  hidden?: boolean;
}

// The picker's original quick colours: the first eight shown, the rest behind
// the "more colours" button.
export const DEFAULT_AMS_COLOR_PALETTE: readonly PaletteColor[] = [
  { name: 'White', hex: 'FFFFFF' },
  { name: 'Black', hex: '000000' },
  { name: 'Red', hex: 'FF0000' },
  { name: 'Blue', hex: '0000FF' },
  { name: 'Green', hex: '00AA00' },
  { name: 'Yellow', hex: 'FFFF00' },
  { name: 'Orange', hex: 'FFA500' },
  { name: 'Gray', hex: '808080' },
  ...[
    { name: 'Cyan', hex: '00FFFF' },
    { name: 'Magenta', hex: 'FF00FF' },
    { name: 'Purple', hex: '800080' },
    { name: 'Pink', hex: 'FFC0CB' },
    { name: 'Brown', hex: '8B4513' },
    { name: 'Beige', hex: 'F5F5DC' },
    { name: 'Navy', hex: '000080' },
    { name: 'Teal', hex: '008080' },
    { name: 'Lime', hex: '32CD32' },
    { name: 'Gold', hex: 'FFD700' },
    { name: 'Silver', hex: 'C0C0C0' },
    { name: 'Maroon', hex: '800000' },
    { name: 'Olive', hex: '808000' },
    { name: 'Coral', hex: 'FF7F50' },
    { name: 'Salmon', hex: 'FA8072' },
    { name: 'Turquoise', hex: '40E0D0' },
    { name: 'Violet', hex: 'EE82EE' },
    { name: 'Indigo', hex: '4B0082' },
    { name: 'Chocolate', hex: 'D2691E' },
    { name: 'Tan', hex: 'D2B48C' },
    { name: 'Slate', hex: '708090' },
    { name: 'Charcoal', hex: '36454F' },
    { name: 'Ivory', hex: 'FFFFF0' },
    { name: 'Cream', hex: 'FFFDD0' },
  ].map((color) => ({ ...color, hidden: true })),
];

/** Mirrors the backend's limits on ams_color_palette. */
export const AMS_COLOR_PALETTE_MAX = 200;
export const AMS_COLOR_NAME_MAX_LEN = 64;

/**
 * Six upper-case hex digits from what a user types: ``#ff8800``, ``FF8800``,
 * the short ``F80`` or an ``RRGGBBAA`` value (the alpha byte is dropped, as
 * the picker sets opaque colours). Anything else is null.
 */
export function normalizeHex(input: string): string | null {
  const digits = input.trim().replace(/^#/, '');
  if (!/^[0-9A-Fa-f]+$/.test(digits)) return null;
  if (digits.length === 3) return digits.split('').map((c) => c + c).join('').toUpperCase();
  if (digits.length === 6 || digits.length === 8) return digits.slice(0, 6).toUpperCase();
  return null;
}

/** The palette from the stored setting; empty or unreadable is the default palette. */
export function parseAmsColorPalette(raw: string | null | undefined): PaletteColor[] {
  if (!raw) return DEFAULT_AMS_COLOR_PALETTE.map((c) => ({ ...c }));
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_AMS_COLOR_PALETTE.map((c) => ({ ...c }));
    const colors: PaletteColor[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { name, hex, hidden } = entry as Record<string, unknown>;
      const normalized = typeof hex === 'string' ? normalizeHex(hex) : null;
      if (typeof name !== 'string' || !name.trim() || !normalized) continue;
      colors.push(hidden === true ? { name, hex: normalized, hidden: true } : { name, hex: normalized });
    }
    return colors;
  } catch {
    return DEFAULT_AMS_COLOR_PALETTE.map((c) => ({ ...c }));
  }
}

function sameAsDefault(colors: readonly PaletteColor[]): boolean {
  return (
    colors.length === DEFAULT_AMS_COLOR_PALETTE.length
    && colors.every((c, i) => {
      const d = DEFAULT_AMS_COLOR_PALETTE[i];
      return c.name === d.name && c.hex === d.hex && !!c.hidden === !!d.hidden;
    })
  );
}

/**
 * The setting value for ``colors``. The default palette stores as empty so the
 * install keeps following the built-in defaults.
 */
export function serializeAmsColorPalette(colors: readonly PaletteColor[]): string {
  if (sameAsDefault(colors)) return '';
  return JSON.stringify(
    colors.map((c) => (c.hidden ? { name: c.name.trim(), hex: c.hex, hidden: true } : { name: c.name.trim(), hex: c.hex })),
  );
}

/**
 * The i18n key (under configureAmsSlot.palette.colors) of a default palette
 * colour, matched by its stored English name and hex; null for a colour the
 * user named or recoloured. The names are stored in English so the palette
 * still reads as the default, and translated where they are shown or picked:
 * the picked name becomes the spool's colour name.
 */
export function defaultColorKey(color: { name: string; hex: string }): string | null {
  const match = DEFAULT_AMS_COLOR_PALETTE.find((d) => d.hex === color.hex && d.name === color.name);
  return match ? match.name.toLowerCase() : null;
}

/** A palette colour's name to show, the defaults through ``translate`` (given the key). */
export function paletteColorLabel(color: { name: string; hex: string }, translate: (key: string) => string): string {
  const key = defaultColorKey(color);
  return key ? translate(key) : color.name;
}

/**
 * The name to store for a colour edited under its shown name: a default
 * colour's translated name goes back to the stored English one.
 */
export function storedColorName(name: string, hex: string, translate: (key: string) => string): string {
  const match = DEFAULT_AMS_COLOR_PALETTE.find((d) => d.hex === hex && translate(d.name.toLowerCase()) === name);
  return match ? match.name : name;
}

/** ``items`` with the entry at ``from`` moved to ``to`` (both clamped), as a new array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}
