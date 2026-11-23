import { isGcodeCompatible } from '../../utils/printer';
import type { VariantCandidate } from './VariantCandidates';

/**
 * Rules for choosing between the ways of printing several sliced files:
 * "alternatives" (one job, the first free printer of a matching model prints
 * its file, #671), "separate" (one queue item per selected file, #3462) or,
 * for a version group only, "printers" (fork: the user picks the printers and
 * each one gets a queue item with the version sliced for its model).
 */
export type MultiFileMode = 'alternatives' | 'separate' | 'printers';

// Case and outer spaces only, not isGcodeCompatible's looser normalizer: a
// duplicate blocks "Alternatives", so it has to be certain, and the backend's
// normalizer has the final say on which models are the same anyway.
const norm = (m: string) => m.trim().toLowerCase();

/** The model that occurs more than once (spelled as in its first occurrence), or null. Unknown models never count. */
export function duplicateModel(files: VariantCandidate[]): string | null {
  const seen = new Set<string>();
  for (const f of files) {
    const m = f.sliced_for_model;
    if (!m) continue;
    const key = norm(m);
    if (seen.has(key)) {
      return files.find((x) => x.sliced_for_model && norm(x.sliced_for_model) === key)!.sliced_for_model;
    }
    seen.add(key);
  }
  return null;
}

/** Alternatives only make sense when every file has a distinct, known model; otherwise separate jobs. */
export function defaultMultiFileMode(files: VariantCandidate[]): MultiFileMode {
  if (files.some((f) => !f.sliced_for_model)) return 'separate';
  return duplicateModel(files) ? 'separate' : 'alternatives';
}

/** The model all files share (first spelling), or null when they differ or one is unknown. */
export function commonModel(files: VariantCandidate[]): string | null {
  if (files.length === 0) return null;
  const first = files[0].sliced_for_model;
  if (!first) return null;
  return files.every((f) => f.sliced_for_model && norm(f.sliced_for_model) === norm(first)) ? first : null;
}

/** Files that cannot run on the target model; files of unknown model count as compatible. */
export function filesIncompatibleWith(files: VariantCandidate[], targetModel: string | null): VariantCandidate[] {
  if (!targetModel) return [];
  return files.filter((f) => !isGcodeCompatible(f.sliced_for_model, targetModel));
}

/** Files sliced for a different model than the printer's (exact comparison, like the single-file warning in index.tsx). */
export function filesNotSlicedFor(files: VariantCandidate[], printerModel: string | null): VariantCandidate[] {
  if (!printerModel) return [];
  return files.filter((f) => f.sliced_for_model && f.sliced_for_model !== printerModel);
}

// The spelling rule of isGcodeCompatible: case, spaces and hyphens don't count.
const modelKey = (m: string) => m.trim().toUpperCase().replace(/[\s-]/g, '');

/**
 * The version a printer of `printerModel` prints (fork, "printers" mode of a
 * version group): the one sliced for its model, else the first in list order
 * whose G-code its model may run (#2578, e.g. a P1S slice on a P1P). A
 * version that names no model is never picked: nothing says it fits. Null
 * when no version fits, or the printer's model is unknown.
 */
export function versionForModel(files: VariantCandidate[], printerModel: string | null | undefined): VariantCandidate | null {
  if (!printerModel) return null;
  const key = modelKey(printerModel);
  const exact = files.find((f) => f.sliced_for_model && modelKey(f.sliced_for_model) === key);
  if (exact) return exact;
  return files.find((f) => f.sliced_for_model && isGcodeCompatible(f.sliced_for_model, printerModel)) ?? null;
}
