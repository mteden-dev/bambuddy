// Uploads from OrcaSlicer waiting for a decision (fork). See
// components/SlicerImportDialog.tsx and backend/app/api/routes/octoprint_compat.py.
import type { LibraryFolderTree, PendingSlicerUpload, PrintQueueItemCreate } from '../api/client';

/** Window event the WebSocket handler fires when an upload arrives. */
export const SLICER_UPLOAD_EVENT = 'slicer-upload';

export const SLICER_INBOX_QUERY_KEY = ['slicer-inbox-pending'] as const;

/** The upload to ask about next: the oldest one not put off for later. */
export function nextPendingUpload(
  pending: PendingSlicerUpload[] | undefined,
  postponed: ReadonlySet<number>,
): PendingSlicerUpload | null {
  return (pending ?? []).find((upload) => !postponed.has(upload.id)) ?? null;
}

/**
 * The queue item "Add to queue" sends: the end of the queue, any printer of
 * the model the file was sliced for, the plate sliced in OrcaSlicer, and the
 * file removed from the library once a printer has it. Filaments are left to
 * the scheduler, which maps them when the job starts. Null when the file names
 * no printer model, so there is no model to queue for.
 */
export function quickQueueItem(upload: PendingSlicerUpload, manualStart: boolean): PrintQueueItemCreate | null {
  if (!upload.sliced_for_model) return null;
  return {
    library_file_id: upload.id,
    target_model: upload.sliced_for_model,
    plate_id: upload.plate ?? null,
    cleanup_library_after_dispatch: true,
    manual_start: manualStart,
  };
}

export interface FolderOption {
  id: number;
  name: string;
  depth: number;
  folder: LibraryFolderTree;
}

/** The folder tree as a flat list in display order, with each folder's depth. */
export function flattenFolders(tree: LibraryFolderTree[] | undefined): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (nodes: LibraryFolderTree[], depth: number) => {
    for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ id: node.id, name: node.name, depth, folder: node });
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(tree ?? [], 0);
  return out;
}

/** Folders an upload can be kept in: writable, internal or writable external, not the inbox it is in. */
export function keepTargets(tree: LibraryFolderTree[] | undefined, inboxFolderId: number | null): FolderOption[] {
  return flattenFolders(tree).filter(
    (option) =>
      option.id !== inboxFolderId &&
      option.folder.can_write !== false &&
      !(option.folder.is_external && option.folder.external_readonly),
  );
}
