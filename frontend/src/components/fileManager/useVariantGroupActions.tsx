import { useCallback, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type LibraryFileListItem } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { isSlicedLibraryFile } from '../../utils/libraryFiles';
import type { GroupRow } from '../../pages/fileManager/variantGroups';
import { invalidateAfterLibraryDelete } from '../../pages/fileManager/invalidate';
import { FocusedConfirmModal } from '../FocusedConfirmModal';
import { useUndoToast } from '../../hooks/useUndoToast';
import { AddVersionModal } from './AddVersionModal';

export interface VariantGroupActions {
  /** Print the group as one job with printer alternatives. */
  print: (row: GroupRow) => void;
  /** Open the print dialog on choosing the printers, each printing the
   *  version for its model (fork). */
  printOn: (row: GroupRow) => void;
  canPrint: (row: GroupRow) => boolean;
  /** At least one version is sliced, so there is something to print. */
  hasPrintable: (row: GroupRow) => boolean;
  ungroup: (row: GroupRow) => void;
  canUngroup: (row: GroupRow) => boolean;
  deleteFiles: (row: GroupRow) => void;
  canDeleteFiles: (row: GroupRow) => boolean;
  /** Fork: takes the row so an undo can put the version back where it was. */
  removeFromGroup: (file: LibraryFileListItem, row: GroupRow) => void;
  canRemove: (file: LibraryFileListItem) => boolean;
  /** Fork: pick a file of the folder on screen to join the group. */
  addVersion: (row: GroupRow) => void;
  canAddVersion: (row: GroupRow) => boolean;
}

type Confirm = { kind: 'ungroup' | 'delete'; row: GroupRow };

// Fork: the files of the listing that may join `row`: sliced, in no group,
// listed here rather than elsewhere, for a printer the group lacks.
export function versionCandidates(row: GroupRow, files: readonly LibraryFileListItem[]): LibraryFileListItem[] {
  const models = new Set(row.members.map((m) => m.sliced_for_model).filter(Boolean));
  return files.filter(
    (f) =>
      isSlicedLibraryFile(f) &&
      f.variant_group_id == null &&
      !f.variant_elsewhere &&
      !(f.sliced_for_model && models.has(f.sliced_for_model)),
  );
}

// The actions of a version group (#3628), shared by the grid card, the list
// row and the columns row: permission checks, the requests, and the confirm
// dialogs, which the caller renders once as `dialogs`. Printing is the
// page's, since the print dialog lives there.
export function useVariantGroupActions({
  onPrintGroup,
  onFilesDeleted,
  listedFiles = [],
}: {
  onPrintGroup: (row: GroupRow, mode?: 'printers') => void;
  onFilesDeleted: (ids: number[]) => void;
  /** Fork: the files on screen, from which a new version is picked. */
  listedFiles?: readonly LibraryFileListItem[];
}): { actions: VariantGroupActions; dialogs: ReactNode } {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const showUndoToast = useUndoToast();
  const { hasPermission, canModify } = useAuth();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [addingTo, setAddingTo] = useState<GroupRow | null>(null);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['library-files'] });
    queryClient.invalidateQueries({ queryKey: ['variant-group'] });
  }, [queryClient]);

  const ungroupMutation = useMutation({
    mutationFn: (groupId: number) => api.deleteVariantGroup(groupId),
    onSuccess: () => {
      refresh();
      showToast(t('fileManager.variants.ungrouped'), 'success');
      setConfirm(null);
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
      setConfirm(null);
    },
  });

  // Fork: puts a removed version back. Removing one of two dissolved the
  // group, so it is made again under its name; otherwise the version is
  // re-added and the old priority order restored. A group with members the
  // caller cannot see may look smaller than it is, hence the fallback.
  const undoRemove = useCallback(
    async (file: LibraryFileListItem, row: GroupRow) => {
      const order = row.members.map((m) => m.id);
      const recreate = () => api.createVariantGroup(order.map((id) => ({ library_file_id: id })), row.name);
      const readd = async () => {
        const group = await api.addVariantGroupMember(row.id, file.id);
        const current = group.members.map((m) => m.library_file_id);
        const wanted = [...order.filter((id) => current.includes(id)), ...current.filter((id) => !order.includes(id))];
        if (wanted.join() !== current.join()) await api.reorderVariantGroup(row.id, wanted);
      };
      const [first, second] = row.members.length <= 2 ? [recreate, readd] : [readd, recreate];
      try {
        try {
          await first();
        } catch (error) {
          try {
            await second();
          } catch {
            throw error;
          }
        }
        showToast(t('fileManager.variants.removeUndone'), 'success');
      } catch (error) {
        showToast((error as Error).message, 'error');
      } finally {
        refresh();
      }
    },
    [refresh, showToast, t],
  );

  const removeMutation = useMutation({
    mutationFn: ({ row, file }: { row: GroupRow; file: LibraryFileListItem }) =>
      api.removeVariantGroupMember(row.id, file.id),
    onSuccess: (_, { row, file }) => {
      refresh();
      showUndoToast(t('fileManager.variants.removed'), () => void undoRemove(file, row));
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const addMutation = useMutation({
    mutationFn: ({ row, file }: { row: GroupRow; file: LibraryFileListItem }) =>
      api.addVariantGroupMember(row.id, file.id),
    onSuccess: (_, { file }) => {
      refresh();
      showToast(t('fileManager.variants.versionAdded', { name: file.print_name || file.filename }), 'success');
      setAddingTo(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => api.bulkDeleteLibrary(ids, []),
    onSuccess: (_, ids) => {
      refresh();
      invalidateAfterLibraryDelete(queryClient);
      showToast(t('fileManager.toast.filesDeleted', { count: ids.length }), 'success');
      onFilesDeleted(ids);
      setConfirm(null);
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
      setConfirm(null);
    },
  });

  const hasPrintable = useCallback((row: GroupRow) => row.members.some(isSlicedLibraryFile), []);
  const canPrint = useCallback(
    (row: GroupRow) => hasPrintable(row) && hasPermission('queue:create'),
    [hasPrintable, hasPermission],
  );
  // Ungroup and delete act on every version, so they are offered only to
  // someone who may change every one of them.
  const canUngroup = useCallback(
    (row: GroupRow) => row.members.every((m) => canModify('library', 'update', m.created_by_id)),
    [canModify],
  );
  const canDeleteFiles = useCallback(
    (row: GroupRow) => row.members.every((m) => canModify('library', 'delete', m.created_by_id)),
    [canModify],
  );
  const canRemove = useCallback(
    (file: LibraryFileListItem) => canModify('library', 'update', file.created_by_id),
    [canModify],
  );

  const actions: VariantGroupActions = {
    print: (row) => {
      if (canPrint(row)) onPrintGroup(row);
    },
    printOn: (row) => {
      if (canPrint(row)) onPrintGroup(row, 'printers');
    },
    canPrint,
    hasPrintable,
    ungroup: (row) => {
      if (canUngroup(row)) setConfirm({ kind: 'ungroup', row });
    },
    canUngroup,
    deleteFiles: (row) => {
      if (canDeleteFiles(row)) setConfirm({ kind: 'delete', row });
    },
    canDeleteFiles,
    removeFromGroup: (file, row) => {
      if (canRemove(file)) removeMutation.mutate({ row, file });
    },
    canRemove,
    addVersion: (row) => {
      if (canUngroup(row)) setAddingTo(row);
    },
    // The server lets a group change only to someone who may change all of
    // it, as for ungrouping.
    canAddVersion: canUngroup,
  };

  // The confirm says how many of the versions sit in other folders: deleting
  // the group deletes those too, which the folder on screen does not show.
  const deleteMessage = (row: GroupRow) => {
    const message = t('fileManager.variants.deleteGroupConfirm', { count: row.members.length, name: row.name });
    const elsewhere = row.members.filter((m) => m.variant_elsewhere).length;
    return elsewhere > 0 ? `${message} ${t('fileManager.variants.deleteGroupElsewhere', { count: elsewhere })}` : message;
  };

  const confirmDialog = confirm ? (
    confirm.kind === 'ungroup' ? (
      <FocusedConfirmModal
        title={t('fileManager.variants.ungroupTitle')}
        message={t('fileManager.variants.ungroupConfirm', { count: confirm.row.members.length, name: confirm.row.name })}
        confirmText={t('fileManager.variants.ungroup')}
        variant="warning"
        isLoading={ungroupMutation.isPending}
        loadingText={t('fileManager.variants.ungrouping')}
        onConfirm={() => ungroupMutation.mutate(confirm.row.id)}
        onCancel={() => setConfirm(null)}
      />
    ) : (
      <FocusedConfirmModal
        title={t('fileManager.variants.deleteGroupTitle', { count: confirm.row.members.length })}
        message={deleteMessage(confirm.row)}
        confirmText={t('common.delete')}
        variant="danger"
        isLoading={deleteMutation.isPending}
        loadingText={t('fileManager.deleting')}
        onConfirm={() => deleteMutation.mutate(confirm.row.members.map((m) => m.id))}
        onCancel={() => setConfirm(null)}
      />
    )
  ) : null;

  const dialogs = (
    <>
      {confirmDialog}
      {addingTo && (
        <AddVersionModal
          row={addingTo}
          candidates={versionCandidates(addingTo, listedFiles).filter((f) =>
            canModify('library', 'update', f.created_by_id),
          )}
          pendingFileId={addMutation.isPending ? (addMutation.variables?.file.id ?? null) : null}
          onPick={(file) => addMutation.mutate({ row: addingTo, file })}
          onClose={() => setAddingTo(null)}
        />
      )}
    </>
  );

  return { actions, dialogs };
}
