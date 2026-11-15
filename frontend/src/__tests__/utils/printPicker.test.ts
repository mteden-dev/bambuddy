import { describe, it, expect } from 'vitest';
import { isSlicedForOtherPrinter, sortPickerFiles } from '../../utils/printPicker';
import type { LibraryFileListItem } from '../../api/client';

const f = (id: number, over: Partial<LibraryFileListItem>): LibraryFileListItem => ({
  id, folder_id: null, is_external: false, filename: `f${id}.gcode.3mf`, file_type: 'gcode.3mf', file_size: 1,
  thumbnail_path: null, print_count: 0, duplicate_count: 0, created_by_id: null, created_by_username: null,
  created_at: '2026-01-01T00:00:00Z', fs_modified_at: null, print_name: null, print_time_seconds: null,
  filament_used_grams: null, sliced_for_model: null, ...over,
});

describe('isSlicedForOtherPrinter', () => {
  it('treats an unknown model on either side as compatible', () => {
    expect(isSlicedForOtherPrinter({ sliced_for_model: null }, 'X1C')).toBe(false);
    expect(isSlicedForOtherPrinter({ sliced_for_model: 'A1' }, '')).toBe(false);
  });
  it('compares models case-insensitively', () => {
    expect(isSlicedForOtherPrinter({ sliced_for_model: 'x1c' }, 'X1C')).toBe(false);
    expect(isSlicedForOtherPrinter({ sliced_for_model: 'A1' }, 'X1C')).toBe(true);
  });
});

describe('sortPickerFiles', () => {
  const files = [
    f(1, { filename: 'b10.gcode.3mf', created_at: '2026-01-02T00:00:00Z', print_count: 1 }),
    f(2, { filename: 'b2.gcode.3mf', created_at: '2026-01-03T00:00:00Z', print_count: 5 }),
    f(3, { filename: 'a.gcode.3mf', print_name: 'Zeta', fs_modified_at: '2026-02-01T00:00:00Z' }),
  ];
  it('sorts by display name with numeric order', () => {
    expect(sortPickerFiles(files, 'name').map((x) => x.id)).toEqual([2, 1, 3]);
  });
  it('sorts newest first by on-disk time, then creation time', () => {
    expect(sortPickerFiles(files, 'newest').map((x) => x.id)).toEqual([3, 2, 1]);
  });
  it('sorts most printed first', () => {
    expect(sortPickerFiles(files, 'printed').map((x) => x.id)).toEqual([2, 1, 3]);
  });
});
