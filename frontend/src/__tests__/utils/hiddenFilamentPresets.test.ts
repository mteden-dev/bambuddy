import { describe, it, expect } from 'vitest';
import {
  parseHiddenFilamentPresets,
  serializeHiddenFilamentPresets,
  toggleHiddenFilamentPreset,
} from '../../utils/hiddenFilamentPresets';

describe('hiddenFilamentPresets', () => {
  it('reads the stored JSON array', () => {
    expect(parseHiddenFilamentPresets('["local_1","builtin_GFB00"]')).toEqual(new Set(['local_1', 'builtin_GFB00']));
  });

  it('hides nothing for an empty, missing or unreadable value', () => {
    expect(parseHiddenFilamentPresets('')).toEqual(new Set());
    expect(parseHiddenFilamentPresets(undefined)).toEqual(new Set());
    expect(parseHiddenFilamentPresets(null)).toEqual(new Set());
    expect(parseHiddenFilamentPresets('not json')).toEqual(new Set());
    expect(parseHiddenFilamentPresets('{"a":1}')).toEqual(new Set());
  });

  it('skips entries that are not preset IDs', () => {
    expect(parseHiddenFilamentPresets('["local_1", 3, "", null]')).toEqual(new Set(['local_1']));
  });

  it('stores the same set as the same text', () => {
    expect(serializeHiddenFilamentPresets(['b', 'a', 'b'])).toBe('["a","b"]');
    expect(serializeHiddenFilamentPresets([])).toBe('[]');
  });

  it('toggles an ID in and out without changing the input', () => {
    const start = new Set(['a']);
    expect(toggleHiddenFilamentPreset(start, 'b')).toEqual(new Set(['a', 'b']));
    expect(toggleHiddenFilamentPreset(start, 'a')).toEqual(new Set());
    expect(start).toEqual(new Set(['a']));
  });
});
