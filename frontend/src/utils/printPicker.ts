import type { LibraryFileListItem } from '../api/client';
import { isGcodeCompatible } from './printer';

export type PrintPickerSort = 'name' | 'newest' | 'printed';

const SORT_STORAGE_KEY = 'bambuddy.printPicker.sort';

export function readStoredSort(): PrintPickerSort {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v === 'name' || v === 'newest' || v === 'printed') return v;
  } catch {
    // Private window or blocked storage: the default will do.
  }
  return 'name';
}

export function storeSort(sort: PrintPickerSort) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // Not worth surfacing: the sort just won't be remembered.
  }
}

/**
 * Is a library file sliced for a printer model whose G-code `printerModel`
 * cannot run?
 *
 * The same rule as the print dialog and the backend (`isGcodeCompatible`):
 * a P1S slice runs on a P1P (CUSTOM_FORK.md), so it is not "other". Unknown
 * on either side is not a mismatch either: a file without `sliced_for_model`
 * (older upload, plain G-code) or a printer without a model is offered, and
 * the print dialog's own checks have the last word.
 */
export function isSlicedForOtherPrinter(
  file: Pick<LibraryFileListItem, 'sliced_for_model'>,
  printerModel: string,
): boolean {
  return !isGcodeCompatible(file.sliced_for_model, printerModel);
}

/**
 * The model a file was sliced for when that is another model whose G-code
 * `printerModel` may still run (a P1S slice on a P1P), else null. The picker
 * offers such a file with a warning badge instead of hiding it.
 */
export function slicedForRelatedModel(
  file: Pick<LibraryFileListItem, 'sliced_for_model'>,
  printerModel: string,
): string | null {
  const slicedFor = file.sliced_for_model;
  if (!slicedFor || !printerModel) return null;
  const key = (m: string) => m.trim().toUpperCase().replace(/[\s-]/g, '');
  if (key(slicedFor) === key(printerModel)) return null;
  return isGcodeCompatible(slicedFor, printerModel) ? slicedFor : null;
}

export function sortPickerFiles(files: LibraryFileListItem[], sort: PrintPickerSort): LibraryFileListItem[] {
  const name = (f: LibraryFileListItem) => (f.print_name || f.filename).toLowerCase();
  const date = (f: LibraryFileListItem) => f.fs_modified_at ?? f.created_at;
  return [...files].sort((a, b) => {
    if (sort === 'newest') {
      const d = date(b).localeCompare(date(a));
      if (d !== 0) return d;
    } else if (sort === 'printed') {
      const p = (b.print_count ?? 0) - (a.print_count ?? 0);
      if (p !== 0) return p;
    }
    return name(a).localeCompare(name(b), undefined, { numeric: true });
  });
}
