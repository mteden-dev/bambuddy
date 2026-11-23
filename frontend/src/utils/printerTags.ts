/**
 * Printer tags (fork): library tags given to printers. An "Any <model>" job
 * goes only to printers that have every tag it asks for; a printer set to
 * "only tagged jobs" also refuses a job asking for none of its tags. A job asks
 * for its file's tags that some printer carries, unless the print dialog gave
 * it others. The rule itself lives in backend/app/services/printer_tags.py;
 * this mirrors it for display only.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, type PrinterTagsEntry } from '../api/client';
import { libraryTagsQueryKey } from './libraryTagsQuery';

export const printerTagsQueryKey = ['printer-tags'] as const;
// Under ['queue'], so every invalidation of the queue refreshes it too.
export const queueItemTagsQueryKey = ['queue', 'printer-tags'] as const;

export interface PrinterTagsData {
  /** Tagged printers only. */
  byPrinter: Map<number, PrinterTagsEntry>;
  /** Every catalog tag, id to name. */
  names: Map<number, string>;
  catalog: { id: number; name: string }[];
  /** Tags some printer carries: the only file tags that route jobs. */
  used: Set<number>;
}

export function usePrinterTags(enabled = true): PrinterTagsData {
  const { data: entries } = useQuery({
    queryKey: printerTagsQueryKey,
    queryFn: api.getPrinterTags,
    enabled,
    staleTime: 30_000,
  });
  const { data: catalog } = useQuery({
    queryKey: libraryTagsQueryKey,
    queryFn: api.getLibraryTags,
    enabled,
  });
  return useMemo(() => {
    const list = entries ?? [];
    return {
      byPrinter: new Map(list.map((e) => [e.printer_id, e])),
      names: new Map((catalog ?? []).map((t) => [t.id, t.name])),
      catalog: (catalog ?? []).map((t) => ({ id: t.id, name: t.name })),
      used: new Set(list.flatMap((e) => e.tag_ids)),
    };
  }, [entries, catalog]);
}

/** The tags a file asks of a printer: its tags that some printer carries. */
export function fileRoutingTags(fileTagIds: Iterable<number>, used: Set<number>): number[] {
  return [...new Set(fileTagIds)].filter((id) => used.has(id));
}

/** Whether a printer with ``entry`` takes a job asking for ``wanted`` (backend PrinterTags.accepts). */
export function printerAcceptsTags(entry: PrinterTagsEntry | undefined, wanted: number[]): boolean {
  const tags = new Set(entry?.tag_ids ?? []);
  if (!wanted.every((id) => tags.has(id))) return false;
  if (entry?.exclusive && tags.size > 0 && !wanted.some((id) => tags.has(id))) return false;
  return true;
}

export function sortedTagNames(ids: Iterable<number>, names: Map<number, string>): string[] {
  return [...ids]
    .map((id) => names.get(id))
    .filter((name): name is string => !!name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
