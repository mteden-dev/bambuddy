import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Loader2, Printer, X } from 'lucide-react';
import type { LibraryFileListItem } from '../../api/client';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import type { GroupRow } from '../../pages/fileManager/variantGroups';

// Fork: picks a sliced file of the folder on screen to join a version group,
// so a new printer's version is added without ungrouping (the H2S version of
// last week's H2C job). Offers only files that can join: sliced, in no group,
// for a printer the group has no version for yet.
export function AddVersionModal({
  row,
  candidates,
  pendingFileId,
  onPick,
  onClose,
}: {
  row: GroupRow;
  candidates: LibraryFileListItem[];
  /** The file whose request is on its way: the list waits for it. */
  pendingFileId: number | null;
  onPick: (file: LibraryFileListItem) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const busy = pendingFileId !== null;
  useModalBehavior(onClose, dialogRef, busy);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 sm:p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('fileManager.variants.addVersionTitle', { name: row.name })}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[80vh] flex flex-col overflow-hidden rounded-t-2xl sm:rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bambu-dark-tertiary">
          <Layers className="w-4 h-4 flex-shrink-0 text-bambu-green" aria-hidden="true" />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-white">
            {t('fileManager.variants.addVersionTitle', { name: row.name })}
          </h3>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            disabled={busy}
            className="p-1.5 rounded flex-shrink-0 text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary disabled:opacity-50 min-w-[44px] min-h-[44px] inline-flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {candidates.length === 0 ? (
            <p className="px-2 py-4 text-sm text-bambu-gray">{t('fileManager.variants.addVersionNone')}</p>
          ) : (
            candidates.map((file) => (
              <button
                key={file.id}
                type="button"
                data-autofocus={file === candidates[0] ? true : undefined}
                onClick={() => onPick(file)}
                disabled={busy}
                className="w-full min-h-[44px] flex items-center gap-2 px-2 py-2 rounded text-left text-sm text-white hover:bg-bambu-dark disabled:opacity-50"
              >
                {pendingFileId === file.id ? (
                  <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin text-bambu-green" aria-hidden="true" />
                ) : (
                  <Printer className="w-4 h-4 flex-shrink-0 text-bambu-green" aria-hidden="true" />
                )}
                <span className="font-medium flex-shrink-0">{file.sliced_for_model || '-'}</span>
                <span className="min-w-0 truncate text-bambu-gray">{file.print_name || file.filename}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
