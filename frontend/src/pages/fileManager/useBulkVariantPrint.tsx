import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type LibraryFileListItem } from '../../api/client';
import { isSlicedLibraryFile } from '../../utils/libraryFiles';
import type { GroupRow } from './variantGroups';
import { planBulkPrint, promotePartialGroups, type BulkPrintPlan } from './variantSelection';

// What the print dialog shows when it is for a group or a single version
// (#3628) rather than for the selection.
interface PrintOverride {
  ids: number[];
  variantFiles: { id: number; filename: string; sliced_for_model: string | null }[] | undefined;
  /** A group opened on "chosen printers" rather than the first free one (fork). */
  groupMode?: 'printers';
}

type PrintQueue = { groups: GroupRow[]; loose: LibraryFileListItem[] };

// Printing version groups from the File Manager (#3628, #3462): one group, one
// version, or a bulk Print whose fully selected groups are one job each and
// whose other files are printed as before. The page owns `printFile` (the
// dialog's trigger); this hook owns what decides how the dialog is filled and
// what follows a finished job.
export function useBulkVariantPrint({
  selectedFiles,
  setSelectedFiles,
  selectableFiles,
  groupRows,
  selectedSlicedFiles,
  setPrintFile,
}: {
  selectedFiles: number[];
  setSelectedFiles: React.Dispatch<React.SetStateAction<number[]>>;
  selectableFiles: ReadonlyMap<number, LibraryFileListItem>;
  /** The version groups as rows on screen, in every pane that lists them. */
  groupRows: readonly GroupRow[];
  selectedSlicedFiles: LibraryFileListItem[];
  setPrintFile: (file: LibraryFileListItem | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [printOverride, setPrintOverride] = useState<PrintOverride | null>(null);
  // Group jobs still to open after the one on screen, then the loose files.
  const [printQueue, setPrintQueue] = useState<PrintQueue | null>(null);
  // Set when onSuccess has just opened the next job, so the close that follows
  // it does not tear the new one down.
  const advanced = useRef(false);
  const [partialPlan, setPartialPlan] = useState<BulkPrintPlan | null>(null);
  // Fork: where a bulk Print of several jobs is ("Job 2 of 3"), and whether
  // closing one is waiting for the user to say what happens to the rest.
  const [chain, setChain] = useState<{ step: number; total: number } | null>(null);
  const [discardPending, setDiscardPending] = useState(false);

  // The latest print request. A group's dialog waits for its fetch, so a
  // request made meanwhile (a version, another group) must not be overwritten
  // when that fetch resolves: the last call wins.
  const printRequest = useRef(0);

  // The plan reads the rows as they are on screen, a group ticked in one
  // column judged by that column's own versions, exactly as the tick box
  // counts them, so a full tick never reads as partial (#3628).
  const plan = useMemo(
    () => planBulkPrint(selectedFiles, groupRows, selectableFiles),
    [selectedFiles, groupRows, selectableFiles],
  );

  // One version on its own, without offering the rest of its group.
  const printVersion = useCallback(
    (file: LibraryFileListItem) => {
      printRequest.current += 1;
      setPrintOverride({ ids: [file.id], variantFiles: undefined });
      setPrintFile(file);
    },
    [setPrintFile],
  );

  // The whole group as one job with printer alternatives, or with `printers`
  // on the printers the user picks, each with the version for its model
  // (fork). Each version's model is the one the server dispatches to (its
  // durable override, else what the file declares), which the list does not
  // carry but the group does; the file's own declared model stands in when
  // that cannot be fetched.
  const printVariantGroup = useCallback(
    async (row: GroupRow, groupMode?: 'printers') => {
      const sliced = row.members.filter(isSlicedLibraryFile);
      if (sliced.length === 0) return;
      const request = ++printRequest.current;
      const targets = new Map<number, string | null>();
      try {
        const group = await queryClient.fetchQuery({
          queryKey: ['variant-group', row.id],
          queryFn: () => api.getVariantGroup(row.id),
          staleTime: 30_000,
          retry: 0,
        });
        for (const m of group.members) targets.set(m.library_file_id, m.target_model);
      } catch {
        // Fall back to each file's declared model.
      }
      if (request !== printRequest.current) return;
      setPrintOverride({
        ids: sliced.map((f) => f.id),
        variantFiles: sliced.map((f) => ({
          id: f.id,
          filename: f.filename,
          sliced_for_model: targets.get(f.id) ?? f.sliced_for_model,
        })),
        groupMode,
      });
      setPrintFile(sliced[0]);
    },
    [queryClient, setPrintFile],
  );

  // The files outside any full group: a lone grouped version prints on its
  // own, anything else is the selection as the dialog always took it.
  const openLoose = (files: LibraryFileListItem[]) => {
    if (files.length === 1 && files[0].variant_group_id != null) printVersion(files[0]);
    else {
      printRequest.current += 1;
      setPrintFile(files[0]);
    }
  };

  const start = (next: BulkPrintPlan) => {
    if (next.fullGroups.length > 0) {
      const [first, ...rest] = next.fullGroups;
      const total = next.fullGroups.length + (next.looseFiles.length > 0 ? 1 : 0);
      setChain(total > 1 ? { step: 1, total } : null);
      setPrintQueue({ groups: rest, loose: next.looseFiles });
      void printVariantGroup(first);
      return;
    }
    setChain(null);
    setPrintQueue(null);
    openLoose(next.looseFiles.length > 0 ? next.looseFiles : selectedSlicedFiles);
  };

  const handleBulkPrint = () => {
    if (plan.partialGroups.length > 0) setPartialPlan(plan);
    else start(plan);
  };

  const confirmPartial = () => {
    if (!partialPlan) return;
    const promoted = promotePartialGroups(partialPlan);
    setPartialPlan(null);
    start(promoted);
  };

  // "Print selection only": the fully selected groups stay one job each, and
  // the partly selected ones print just the versions that are ticked.
  const printSelectionOnly = () => {
    if (!partialPlan) return;
    const current = partialPlan;
    setPartialPlan(null);
    start(current);
  };

  // The dialog closed. True when that only handed over to the next job.
  const consumeAdvance = () => {
    if (!advanced.current) return false;
    advanced.current = false;
    return true;
  };

  const reset = () => {
    setPrintOverride(null);
    setPrintQueue(null);
    setChain(null);
    setDiscardPending(false);
  };

  // Jobs of a bulk Print still to open after the one on screen.
  const remainingJobs = printQueue ? printQueue.groups.length + (printQueue.loose.length > 0 ? 1 : 0) : 0;

  // Opens the next job of the queue; false when there is none.
  const openNext = (): boolean => {
    const queue = printQueue;
    if (queue && queue.groups.length > 0) {
      const [next, ...rest] = queue.groups;
      setPrintQueue({ ...queue, groups: rest });
      setChain((c) => (c ? { ...c, step: c.step + 1 } : c));
      void printVariantGroup(next);
      return true;
    }
    setPrintQueue(null);
    if (queue && queue.loose.length > 0) {
      setChain((c) => (c ? { ...c, step: c.step + 1 } : c));
      openLoose(queue.loose);
      return true;
    }
    setChain(null);
    return false;
  };

  // The dialog was closed without queuing (fork). With jobs left, they are
  // not dropped silently: true means the page asks first (`discardPending`).
  const closeJob = (): boolean => {
    if (remainingJobs > 0) {
      setPrintOverride(null);
      setDiscardPending(true);
      return true;
    }
    reset();
    return false;
  };

  // The answers to that question: skip just the closed job, or all the rest.
  const nextJob = () => {
    setDiscardPending(false);
    openNext();
  };
  const discardRest = reset;

  // A job was queued. True when it was a group or a version, which leaves
  // only what was printed out of the selection and goes on with the next job
  // of a bulk Print; false when it was the plain selection.
  const completeJob = (): boolean => {
    const finished = printOverride;
    setPrintOverride(null);
    if (!finished) return false;
    setSelectedFiles((prev) => prev.filter((id) => !finished.ids.includes(id)));
    if (printQueue && openNext()) advanced.current = true;
    return true;
  };

  // The Print button's text: one job says Print, several count what they are.
  const groups = plan.fullGroups.length;
  const loose = plan.looseFiles.length;
  let printLabel = t('common.print');
  if (groups > 0 && loose > 0) {
    printLabel = t('fileManager.variants.printGroupsAndFiles', {
      groups: t('fileManager.variants.groupCount', { count: groups }),
      files: t('fileManager.variants.fileCount', { count: loose }),
    });
  } else if (groups > 1) {
    printLabel = t('fileManager.variants.printJobs', { count: groups });
  } else if (groups === 0 && selectedSlicedFiles.length > 1) {
    printLabel = t('fileManager.printFiles', { count: selectedSlicedFiles.length });
  }

  return {
    printOverride,
    partialPlan,
    dismissPartial: () => setPartialPlan(null),
    printLabel,
    printVariantGroup,
    printVersion,
    handleBulkPrint,
    confirmPartial,
    printSelectionOnly,
    consumeAdvance,
    reset,
    completeJob,
    chain,
    remainingJobs,
    closeJob,
    discardPending,
    nextJob,
    discardRest,
  };
}
