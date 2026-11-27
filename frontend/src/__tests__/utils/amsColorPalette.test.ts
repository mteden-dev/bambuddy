import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AMS_COLOR_PALETTE,
  defaultColorKey,
  moveItem,
  paletteColorLabel,
  storedColorName,
  normalizeHex,
  parseAmsColorPalette,
  serializeAmsColorPalette,
} from '../../utils/amsColorPalette';

describe('amsColorPalette', () => {
  it('starts from the original picker colours: eight shown, the rest hidden', () => {
    const palette = parseAmsColorPalette('');
    expect(palette.filter((c) => !c.hidden).map((c) => c.name)).toEqual([
      'White', 'Black', 'Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Gray',
    ]);
    expect(palette.filter((c) => c.hidden)).toHaveLength(24);
  });

  it('falls back to the defaults for an unreadable value', () => {
    expect(parseAmsColorPalette('nope')).toEqual(DEFAULT_AMS_COLOR_PALETTE);
    expect(parseAmsColorPalette('{"a":1}')).toEqual(DEFAULT_AMS_COLOR_PALETTE);
  });

  it('reads a stored palette in order and skips broken entries', () => {
    const raw = JSON.stringify([
      { name: 'Jade White', hex: 'ffffff' },
      { name: '', hex: '000000' },
      { name: 'Bad', hex: 'xyz' },
      { name: 'Bambu Green', hex: '00AE42', hidden: true },
    ]);
    expect(parseAmsColorPalette(raw)).toEqual([
      { name: 'Jade White', hex: 'FFFFFF' },
      { name: 'Bambu Green', hex: '00AE42', hidden: true },
    ]);
  });

  it('keeps an empty stored palette empty', () => {
    expect(parseAmsColorPalette('[]')).toEqual([]);
  });

  it('stores the default palette as empty so it keeps following the defaults', () => {
    expect(serializeAmsColorPalette(DEFAULT_AMS_COLOR_PALETTE)).toBe('');
    expect(serializeAmsColorPalette([{ name: ' Jade White ', hex: 'FFFFFF' }])).toBe(
      '[{"name":"Jade White","hex":"FFFFFF"}]',
    );
  });

  it.each([
    ['#ff8800', 'FF8800'],
    ['FF8800', 'FF8800'],
    ['f80', 'FF8800'],
    ['FF8800CC', 'FF8800'],
    [' #00ae42 ', '00AE42'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each(['', '#', 'FF88', 'GG8800', 'FF8800C'])('rejects %s', (input) => {
    expect(normalizeHex(input)).toBeNull();
  });

  it('moves an entry without changing the input', () => {
    const items = ['a', 'b', 'c'];
    expect(moveItem(items, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(items, 2, -5)).toEqual(['c', 'a', 'b']);
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('translates the default colours where shown, and stores them back in English', () => {
    const polish: Record<string, string> = { white: 'Biały', black: 'Czarny' };
    const translate = (key: string) => polish[key] ?? key;
    expect(defaultColorKey({ name: 'White', hex: 'FFFFFF' })).toBe('white');
    // Renamed or recoloured: the user's own, shown as it is.
    expect(defaultColorKey({ name: 'Jade White', hex: 'FFFFFF' })).toBeNull();
    expect(defaultColorKey({ name: 'White', hex: 'F5F5F5' })).toBeNull();
    expect(paletteColorLabel({ name: 'White', hex: 'FFFFFF' }, translate)).toBe('Biały');
    expect(paletteColorLabel({ name: 'Jade White', hex: 'FFFFFF' }, translate)).toBe('Jade White');
    expect(storedColorName('Biały', 'FFFFFF', translate)).toBe('White');
    expect(storedColorName('Biały', '123456', translate)).toBe('Biały');
  });
});
