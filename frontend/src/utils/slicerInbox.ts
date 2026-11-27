// Uploads from OrcaSlicer waiting for a decision (fork). See
// components/SlicerImportDialog.tsx and backend/app/api/routes/octoprint_compat.py.
import type {
  LibraryFolderTree,
  PendingSlicerUpload,
  PrintQueueItemCreate,
  SlicerUploadDecision,
} from '../api/client';

/** Window event the WebSocket handler fires when an upload arrives. */
export const SLICER_UPLOAD_EVENT = 'slicer-upload';

/** Window event the WebSocket handler fires when an upload was decided (`slicer_upload_decided`). */
export const SLICER_DECIDED_EVENT = 'slicer-upload-decided';

export const SLICER_INBOX_QUERY_KEY = ['slicer-inbox-pending'] as const;

/** What `slicer_upload_decided` carries. */
export interface SlicerDecidedDetail {
  file_id: number;
  decision?: SlicerUploadDecision;
  claim?: string | null;
}

// One id per open tab: a decision's claim starts with it, so the tab tells its
// own decisions from another device's. Not crypto.randomUUID, which plain
// http (the app on a LAN address) does not have.
const TAB_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
let claimCounter = 0;

/** A new decision id for one upload (sent with its queue jobs and discard). */
export function newDecisionClaim(): string {
  claimCounter += 1;
  return `${TAB_ID}:${claimCounter}`;
}

/** Whether `claim` names a decision made in this tab. */
export function isOwnClaim(claim: string | null | undefined): boolean {
  return !!claim && claim.startsWith(`${TAB_ID}:`);
}

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
export function quickQueueItem(
  upload: PendingSlicerUpload,
  manualStart: boolean,
  claim?: string,
): PrintQueueItemCreate | null {
  if (!upload.sliced_for_model) return null;
  return {
    library_file_id: upload.id,
    target_model: upload.sliced_for_model,
    plate_id: upload.plate ?? null,
    cleanup_library_after_dispatch: true,
    manual_start: manualStart,
    ...(claim ? { slicer_inbox_claim: claim } : {}),
  };
}

/**
 * The label of a folder option: its whole path ("H2S / Boxes"). An <option>
 * collapses leading spaces, so indenting by depth left two folders of one
 * name looking the same.
 */
export function folderPathLabel(option: FolderOption): string {
  return option.path.join(' / ');
}

export interface FolderOption {
  id: number;
  name: string;
  depth: number;
  /** The names from the top folder down to this one. */
  path: string[];
  folder: LibraryFolderTree;
}

/** The folder tree as a flat list in display order, with each folder's depth and path. */
export function flattenFolders(tree: LibraryFolderTree[] | undefined): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (nodes: LibraryFolderTree[], parents: string[]) => {
    for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = [...parents, node.name];
      out.push({ id: node.id, name: node.name, depth: parents.length, path, folder: node });
      walk(node.children ?? [], path);
    }
  };
  walk(tree ?? [], []);
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
