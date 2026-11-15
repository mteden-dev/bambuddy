import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowUpDown,
  ChevronRight,
  Clock,
  FileBox,
  Folder,
  Home,
  Loader2,
  Printer as PrinterIcon,
  Search,
  Upload,
  Weight,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { LibraryFileListItem, LibraryFolderTree } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { formatDateOnly, formatDuration } from '../utils/date';
import { isSlicedLibraryFile, mayBeSlicedFileName } from '../utils/libraryFiles';
import { mapModelCode } from '../utils/printerModel';
import { PrintModal } from './PrintModal';
import {
  isSlicedForOtherPrinter,
  readStoredSort,
  sortPickerFiles,
  storeSort,
  type PrintPickerSort,
} from '../utils/printPicker';
import { Button } from './Button';

interface FolderIndexEntry {
  folder: LibraryFolderTree;
  parentId: number | null;
}

function indexFolders(tree: LibraryFolderTree[]): Map<number, FolderIndexEntry> {
  const map = new Map<number, FolderIndexEntry>();
  const walk = (nodes: LibraryFolderTree[], parentId: number | null) => {
    for (const node of nodes) {
      map.set(node.id, { folder: node, parentId });
      walk(node.children ?? [], node.id);
    }
  };
  walk(tree, null);
  return map;
}

interface PrintFromLibraryModalProps {
  printerId: number;
  printerName: string;
  /** SSDP model code of the printer, as stored on the printer row. */
  printerModel: string | null;
  onClose: () => void;
}

/**
 * The printer card's Print button: pick a sliced file from the library and
 * print it on this printer, or upload a new one into the open folder.
 *
 * Only sliced files are listed (a source 3MF or STL cannot be dispatched), and
 * by default only those sliced for this printer's model; folders without any
 * such file are left out so the tree shows only where something printable is.
 * The library is read once, flat, and walked client-side: folder counts then
 * reflect what this picker would actually offer, not the folder's raw size.
 */
export function PrintFromLibraryModal({ printerId, printerName, printerModel, onClose }: PrintFromLibraryModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canUpload = hasPermission('library:upload');

  const [folderId, setFolderId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PrintPickerSort>(readStoredSort);
  const [showOtherPrinters, setShowOtherPrinters] = useState(false);
  const [printFile, setPrintFile] = useState<LibraryFileListItem | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const model = mapModelCode(printerModel);

  const foldersQuery = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
  });
  // include_root=false with no folder: every file the user may read.
  const filesQuery = useQuery({
    queryKey: ['library-files', 'print-picker'],
    queryFn: () => api.getLibraryFiles(undefined, false),
  });

  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);

  const sliced = useMemo(
    () => (filesQuery.data ?? []).filter((f) => isSlicedLibraryFile(f)),
    [filesQuery.data],
  );
  const offered = useMemo(
    () => (showOtherPrinters ? sliced : sliced.filter((f) => !isSlicedForOtherPrinter(f, model))),
    [sliced, showOtherPrinters, model],
  );
  const hiddenOtherCount = sliced.length - sliced.filter((f) => !isSlicedForOtherPrinter(f, model)).length;

  // How many offered files each folder holds, its subfolders included.
  const offeredCountByFolder = useMemo(() => {
    const counts = new Map<number, number>();
    for (const file of offered) {
      let id = file.folder_id;
      const seen = new Set<number>();
      while (id !== null && !seen.has(id)) {
        seen.add(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        id = folderIndex.get(id)?.parentId ?? null;
      }
    }
    return counts;
  }, [offered, folderIndex]);

  // A folder deleted (or filtered empty) under the open view falls back to the root.
  useEffect(() => {
    if (folderId !== null && foldersQuery.data && !folderIndex.has(folderId)) setFolderId(null);
  }, [folderId, folderIndex, foldersQuery.data]);

  const breadcrumb = useMemo(() => {
    const path: LibraryFolderTree[] = [];
    let id = folderId;
    const seen = new Set<number>();
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      const entry = folderIndex.get(id);
      if (!entry) break;
      path.unshift(entry.folder);
      id = entry.parentId;
    }
    return path;
  }, [folderId, folderIndex]);

  const query = search.trim().toLowerCase();

  const visibleFolders = useMemo(() => {
    if (query) return [];
    const children = folderId === null ? foldersQuery.data ?? [] : folderIndex.get(folderId)?.folder.children ?? [];
    return children
      .filter((f) => (offeredCountByFolder.get(f.id) ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [query, folderId, foldersQuery.data, folderIndex, offeredCountByFolder]);

  const visibleFiles = useMemo(() => {
    const list = query
      ? offered.filter(
          (f) => f.filename.toLowerCase().includes(query) || (f.print_name ?? '').toLowerCase().includes(query),
        )
      : offered.filter((f) => f.folder_id === folderId);
    return sortPickerFiles(list, sort);
  }, [query, offered, folderId, sort]);

  // The rest of the file's variant group (#2570), so a grouped job keeps its
  // alternatives here as it does from the File Manager.
  const { data: printFileGroup } = useQuery({
    queryKey: ['variant-group', printFile?.variant_group_id],
    queryFn: () => api.getVariantGroup(printFile!.variant_group_id!),
    enabled: !!printFile?.variant_group_id,
  });
  const variantFiles = useMemo(() => {
    if (!printFile || !printFileGroup || printFileGroup.members.length < 2) return undefined;
    return printFileGroup.members.map((m) => ({
      id: m.library_file_id,
      filename: m.filename,
      sliced_for_model: m.target_model,
    }));
  }, [printFile, printFileGroup]);

  // Uploads land in the open folder when the user may write there; the root
  // otherwise (a read-only external folder, or someone else's folder).
  const openFolder = folderId !== null ? folderIndex.get(folderId)?.folder : undefined;
  const uploadFolder =
    openFolder && openFolder.can_write && !(openFolder.is_external && openFolder.external_readonly)
      ? openFolder
      : undefined;

  const subModalOpen = printFile !== null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !subModalOpen && !uploading) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, subModalOpen, uploading]);

  // Not on touch screens: the keyboard would cover the list before anyone asked to search.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) searchRef.current?.focus();
  }, []);

  const changeSort = (next: PrintPickerSort) => {
    setSort(next);
    storeSort(next);
  };

  const openFolderView = (id: number | null) => {
    setFolderId(id);
    setSearch('');
  };

  const uploadAndPrint = useCallback(
    async (file: File) => {
      setError(null);
      if (!mayBeSlicedFileName(file.name)) {
        setError(t('printers.dropNotPrintable'));
        return;
      }
      setUploading(file.name);
      try {
        const result = await api.uploadLibraryFile(file, uploadFolder?.id ?? null);
        if (!isSlicedLibraryFile(result)) {
          await api.deleteLibraryFile(result.id).catch(() => {});
          setError(t('printers.dropNotSliced'));
          return;
        }
        const slicedFor = (result.metadata as Record<string, unknown> | null)?.sliced_for_model as string | undefined;
        if (slicedFor && model && slicedFor.toLowerCase() !== model.toLowerCase()) {
          await api.deleteLibraryFile(result.id).catch(() => {});
          setError(t('printers.incompatibleFile', { slicedFor, printerModel: model }));
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['library-files'] });
        queryClient.invalidateQueries({ queryKey: ['library-folders'] });
        setPrintFile({
          id: result.id,
          folder_id: uploadFolder?.id ?? null,
          is_external: false,
          filename: result.filename,
          file_type: result.file_type,
          file_size: result.file_size,
          thumbnail_path: result.thumbnail_path,
          print_count: 0,
          duplicate_count: 0,
          created_by_id: null,
          created_by_username: null,
          created_at: new Date().toISOString(),
          fs_modified_at: null,
          print_name: null,
          print_time_seconds: null,
          filament_used_grams: null,
          sliced_for_model: slicedFor ?? null,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('common.uploadFailed'));
      } finally {
        setUploading(null);
      }
    },
    [t, uploadFolder, model, queryClient],
  );

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!canUpload || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canUpload || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !uploading) void uploadAndPrint(file);
  };

  const isLoading = filesQuery.isLoading || foldersQuery.isLoading;
  const loadFailed = filesQuery.isError || foldersQuery.isError;
  const folderName = (id: number | null) => (id === null ? t('printPicker.library') : folderIndex.get(id)?.folder.name ?? '');

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-2 sm:p-4 ${subModalOpen ? 'hidden' : ''}`}
        onClick={() => !uploading && onClose()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="print-picker-title"
          className="relative w-full max-w-4xl h-[90vh] sm:h-[85vh] flex flex-col bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-bambu-dark-tertiary flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <PrinterIcon className="w-5 h-5 text-bambu-green flex-shrink-0" />
              <div className="min-w-0">
                <h2 id="print-picker-title" className="text-lg font-semibold text-white truncate">
                  {t('printPicker.title', { printer: printerName })}
                </h2>
                <p className="text-xs text-bambu-gray truncate">
                  {model ? t('printPicker.subtitleModel', { model }) : t('printPicker.subtitle')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {canUpload && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!uploading}
                  title={t('printPicker.uploadTo', { folder: uploadFolder?.name ?? t('printPicker.library') })}
                >
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  <span className="hidden sm:inline">{t('printPicker.upload')}</span>
                </Button>
              )}
              <button
                onClick={onClose}
                disabled={!!uploading}
                className="p-1.5 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark disabled:opacity-50"
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-bambu-dark-tertiary bg-bambu-dark/40 flex-shrink-0">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('printPicker.search')}
                aria-label={t('printPicker.search')}
                className="w-full pl-9 pr-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-white placeholder:text-bambu-gray focus:outline-none focus:border-bambu-green"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm text-bambu-gray">
              <ArrowUpDown className="w-4 h-4" />
              <span className="sr-only">{t('printPicker.sortBy')}</span>
              <select
                value={sort}
                onChange={(e) => changeSort(e.target.value as PrintPickerSort)}
                aria-label={t('printPicker.sortBy')}
                className="bg-bambu-dark border border-bambu-dark-tertiary rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-bambu-green"
              >
                <option value="name">{t('printPicker.sortName')}</option>
                <option value="newest">{t('printPicker.sortNewest')}</option>
                <option value="printed">{t('printPicker.sortMostPrinted')}</option>
              </select>
            </label>
          </div>

          {/* Breadcrumb */}
          <nav
            aria-label={t('printPicker.location')}
            className="flex items-center gap-1 px-4 py-2 text-sm text-bambu-gray overflow-x-auto whitespace-nowrap flex-shrink-0"
          >
            {query ? (
              <span>{t('printPicker.searchingAll')}</span>
            ) : (
              <>
                <button
                  onClick={() => openFolderView(null)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:text-white hover:bg-bambu-dark ${folderId === null ? 'text-white font-medium' : ''}`}
                >
                  <Home className="w-3.5 h-3.5" />
                  {t('printPicker.library')}
                </button>
                {breadcrumb.map((f, i) => (
                  <span key={f.id} className="flex items-center gap-1">
                    <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                    <button
                      onClick={() => openFolderView(f.id)}
                      className={`px-1.5 py-0.5 rounded hover:text-white hover:bg-bambu-dark ${i === breadcrumb.length - 1 ? 'text-white font-medium' : ''}`}
                    >
                      {f.name}
                    </button>
                  </span>
                ))}
              </>
            )}
          </nav>

          {error && (
            <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} aria-label={t('common.close')} className="text-red-300/70 hover:text-red-200">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* List */}
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-bambu-gray">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : loadFailed ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-bambu-gray">
                <AlertCircle className="w-8 h-8" />
                <p>{t('printPicker.loadError')}</p>
              </div>
            ) : visibleFolders.length === 0 && visibleFiles.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <FileBox className="w-10 h-10 text-bambu-gray/60" />
                <p className="text-white font-medium">
                  {query ? t('printPicker.noResults', { query: search.trim() }) : t('printPicker.empty')}
                </p>
                {!query && <p className="max-w-md text-sm text-bambu-gray">{t('printPicker.emptyHint')}</p>}
                {canUpload && !query && (
                  <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={!!uploading}>
                    <Upload className="w-4 h-4" />
                    {t('printPicker.upload')}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {visibleFolders.map((folder) => {
                  const count = offeredCountByFolder.get(folder.id) ?? 0;
                  return (
                    <li key={`folder-${folder.id}`}>
                      <button
                        onClick={() => openFolderView(folder.id)}
                        className="w-full flex items-center gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/60 px-3 py-2.5 text-left hover:border-bambu-green/60 hover:bg-bambu-dark transition-colors"
                      >
                        <span className="flex w-12 h-12 flex-shrink-0 items-center justify-center rounded-md bg-bambu-green/10">
                          <Folder className="w-6 h-6 text-bambu-green" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-white">{folder.name}</span>
                          <span className="block text-xs text-bambu-gray">
                            {t('printPicker.printableCount', { count })}
                          </span>
                        </span>
                        <ChevronRight className="w-4 h-4 text-bambu-gray flex-shrink-0" />
                      </button>
                    </li>
                  );
                })}
                {visibleFiles.map((file) => {
                  const otherPrinter = isSlicedForOtherPrinter(file, model);
                  const title = otherPrinter
                    ? t('printers.incompatibleFile', { slicedFor: file.sliced_for_model, printerModel: model })
                    : t('printPicker.printThis', { printer: printerName });
                  return (
                    <li key={`file-${file.id}`}>
                      <button
                        onClick={() => !otherPrinter && setPrintFile(file)}
                        disabled={otherPrinter}
                        title={title}
                        className="group w-full flex items-center gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/60 px-3 py-2.5 text-left transition-colors enabled:hover:border-bambu-green/60 enabled:hover:bg-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="flex w-12 h-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-bambu-dark-tertiary">
                          {file.thumbnail_path ? (
                            <img
                              src={api.getLibraryFileThumbnailUrl(file.id)}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <FileBox className="w-6 h-6 text-bambu-gray" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-white">{file.print_name || file.filename}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-bambu-gray">
                            {file.sliced_for_model && (
                              <span
                                className={`rounded-full border px-2 py-0.5 ${otherPrinter ? 'border-amber-500/50 text-amber-400' : 'border-bambu-dark-tertiary text-bambu-gray'}`}
                              >
                                {file.sliced_for_model}
                              </span>
                            )}
                            {file.print_time_seconds ? (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3.5 h-3.5" />
                                {formatDuration(file.print_time_seconds)}
                              </span>
                            ) : null}
                            {file.filament_used_grams ? (
                              <span className="flex items-center gap-1">
                                <Weight className="w-3.5 h-3.5" />
                                {Math.round(file.filament_used_grams)} g
                              </span>
                            ) : null}
                            {file.print_count > 0 && <span>{t('printPicker.printedTimes', { count: file.print_count })}</span>}
                            {query && (
                              <span className="flex items-center gap-1 truncate">
                                <Folder className="w-3.5 h-3.5" />
                                {folderName(file.folder_id)}
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="hidden sm:block flex-shrink-0 text-xs text-bambu-gray">
                          {formatDateOnly(file.fs_modified_at ?? file.created_at)}
                        </span>
                        {/* Kept in the layout on a disabled row too, so the dates line up. */}
                        <span
                          aria-hidden="true"
                          className={`hidden sm:flex flex-shrink-0 items-center gap-1 rounded-md bg-bambu-green px-2.5 py-1.5 text-xs font-medium text-white opacity-0 transition-opacity ${otherPrinter ? 'invisible' : 'group-hover:opacity-100 group-focus-visible:opacity-100'}`}
                        >
                          <PrinterIcon className="w-3.5 h-3.5" />
                          {t('common.print')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-bambu-dark-tertiary text-xs text-bambu-gray flex-shrink-0">
            <span>
              {canUpload
                ? t('printPicker.dropHint', { folder: uploadFolder?.name ?? t('printPicker.library') })
                : t('printPicker.onlySliced')}
            </span>
            {hiddenOtherCount > 0 && (
              <button
                onClick={() => setShowOtherPrinters((v) => !v)}
                className="text-bambu-green hover:underline"
              >
                {showOtherPrinters
                  ? t('printPicker.hideOtherPrinters')
                  : t('printPicker.showOtherPrinters', { count: hiddenOtherCount })}
              </button>
            )}
          </div>

          {(isDragging || uploading) && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-bambu-dark/85 p-6">
              <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-bambu-green px-10 py-8 text-center">
                {uploading ? (
                  <>
                    <Loader2 className="w-10 h-10 animate-spin text-bambu-green" />
                    <p className="font-medium text-white">{t('common.uploading')}</p>
                    <p className="max-w-xs truncate text-sm text-bambu-gray">{uploading}</p>
                  </>
                ) : (
                  <>
                    <Upload className="w-10 h-10 text-bambu-green" />
                    <p className="font-medium text-white">
                      {t('printPicker.dropToUpload', { folder: uploadFolder?.name ?? t('printPicker.library') })}
                    </p>
                    <p className="text-sm text-bambu-gray">{t('printPicker.onlySliced')}</p>
                  </>
                )}
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".gcode,.3mf"
            className="hidden"
            data-testid="print-picker-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void uploadAndPrint(file);
            }}
          />
        </div>
      </div>

      {/* Held back until the variant group has loaded: the dialog reads its
          candidates once, on mount. Cancelling returns to the picker. */}
      {printFile && (!printFile.variant_group_id || printFileGroup !== undefined) && (
        <PrintModal
          mode="create"
          libraryFileId={variantFiles?.[0]?.id ?? printFile.id}
          variantFiles={variantFiles}
          archiveName={
            variantFiles && variantFiles.length > 1
              ? `${variantFiles[0].filename} ${t('common.plusNMore', { count: variantFiles.length - 1 })}`
              : printFile.print_name || printFile.filename
          }
          initialSelectedPrinterIds={[printerId]}
          onClose={() => setPrintFile(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            queryClient.invalidateQueries({ queryKey: ['queue'] });
            queryClient.invalidateQueries({ queryKey: ['archives'] });
            onClose();
          }}
        />
      )}
    </>
  );
}
