import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileBox,
  FolderInput,
  ListPlus,
  Loader2,
  Printer as PrinterIcon,
  Send,
  Trash2,
  Weight,
  X,
} from 'lucide-react';
import { api, ApiError, slicerInboxApi, type PendingSlicerUpload, type SlicerUploadDecision } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { formatDuration } from '../utils/date';
import {
  SLICER_DECIDED_EVENT,
  SLICER_INBOX_QUERY_KEY,
  SLICER_UPLOAD_EVENT,
  folderPathLabel,
  isOwnClaim,
  keepTargets,
  newDecisionClaim,
  nextPendingUpload,
  quickQueueItem,
  type SlicerDecidedDetail,
} from '../utils/slicerInbox';
import { Button } from './Button';
import { PrintModal } from './PrintModal';
import type { ScheduleOptions } from './PrintModal/types';

const LAST_FOLDER_KEY = 'slicerInbox.lastFolder';
// How long "handled on another device" stays before the next file is asked about.
const HANDLED_ELSEWHERE_MS = 4000;
// How long the toast of a discard offers "Undo".
const UNDO_DISCARD_MS = 10000;

function readLastFolder(): number | null {
  try {
    const raw = localStorage.getItem(LAST_FOLDER_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function storeLastFolder(id: number | null) {
  try {
    if (id === null) localStorage.removeItem(LAST_FOLDER_KEY);
    else localStorage.setItem(LAST_FOLDER_KEY, String(id));
  } catch {
    // A private window: the choice is simply not remembered.
  }
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

const isConflict = (err: unknown) => err instanceof ApiError && err.status === 409;

interface PrintRequest {
  upload: PendingSlicerUpload;
  scheduleOptions?: Partial<ScheduleOptions>;
  /** The decision id its queue jobs carry. */
  claim: string;
}

interface HandledElsewhere {
  upload: PendingSlicerUpload;
  /** What the other device did; null when the file was simply gone. */
  decision: SlicerUploadDecision | null;
}

/**
 * Asks what to do with a file uploaded from OrcaSlicer (fork). OrcaSlicer
 * sends to Bambuddy as to an OctoPrint host; the file waits in the library's
 * inbox folder, and this dialog -- mounted once in the Layout -- opens for its
 * uploader wherever Bambuddy is open: in OrcaSlicer's Device tab or in a
 * browser. Uploads that arrived while nothing was open are asked about on the
 * next visit, oldest first.
 *
 * - Print: the print dialog, plate preselected, ASAP, file removed from the
 *   library once a printer has it (the archive keeps a copy).
 * - Add to queue: one click, any printer of the model it was sliced for, at
 *   the end of the queue. If that is refused, the reason is shown and the
 *   print dialog opens on the queue choice instead.
 * - Save to files: moved to a library folder, optionally renamed.
 * - Discard: moved to the library trash, with "Undo" in its toast.
 *
 * Every open session of the uploader asks, so each action first checks that
 * the file still waits, carries a decision id the server holds a second
 * device to (409), and the server tells the other sessions what was decided
 * (`slicer_upload_decided`): they say so for a moment instead of offering the
 * file again.
 *
 * Closing the dialog puts the file off; a small button then brings it back.
 */
export function SlicerImportDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast, showPersistentToast, dismissToast } = useToast();
  const { authEnabled, loading: authLoading, hasPermission, hasAnyPermission } = useAuth();

  const canRead = !authLoading && (!authEnabled || hasAnyPermission('library:read_own', 'library:read_all'));
  const canQueue = hasPermission('queue:create');
  const canKeep = hasAnyPermission('library:update_own', 'library:update_all');
  const canDiscard = hasAnyPermission('library:delete_own', 'library:delete_all');

  const pendingQuery = useQuery({
    queryKey: SLICER_INBOX_QUERY_KEY,
    queryFn: slicerInboxApi.getPending,
    enabled: canRead,
  });
  const { data: uiFlags } = useQuery({ queryKey: ['ui-flags'], queryFn: api.getUiFlags, enabled: canRead });
  const manualStart = !!uiFlags?.slicer_inbox_manual_start;

  // Put off with "Later" (until the button below brings them back), and those
  // already decided while the list refreshes.
  const [postponed, setPostponed] = useState<Set<number>>(() => new Set());
  const [decidedIds, setDecidedIds] = useState<Set<number>>(() => new Set());
  const [printRequest, setPrintRequest] = useState<PrintRequest | null>(null);
  const [handledElsewhere, setHandledElsewhere] = useState<HandledElsewhere | null>(null);
  const [view, setView] = useState<'choose' | 'keep'>('choose');
  const [busy, setBusy] = useState<'print' | 'queue' | 'keep' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keepFolderId, setKeepFolderId] = useState<number | null>(null);
  const [keepName, setKeepName] = useState('');
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);

  const skipped = useMemo(() => new Set([...postponed, ...decidedIds]), [postponed, decidedIds]);
  const queued = nextPendingUpload(pendingQuery.data, skipped);
  // While "handled elsewhere" is said, that file stays on screen.
  const current = handledElsewhere?.upload ?? queued;
  const waiting = (pendingQuery.data ?? []).filter((u) => !skipped.has(u.id));
  const position = current ? waiting.findIndex((u) => u.id === current.id) + 1 : 0;
  const postponedWaiting = (pendingQuery.data ?? []).filter((u) => postponed.has(u.id) && !decidedIds.has(u.id));

  const refreshPending = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SLICER_INBOX_QUERY_KEY });
  }, [queryClient]);

  useEffect(() => {
    window.addEventListener(SLICER_UPLOAD_EVENT, refreshPending);
    return () => window.removeEventListener(SLICER_UPLOAD_EVENT, refreshPending);
  }, [refreshPending]);

  const showHandledElsewhere = useCallback((upload: PendingSlicerUpload, decision: SlicerUploadDecision | null) => {
    setDecidedIds((prev) => new Set(prev).add(upload.id));
    setPrintRequest((prev) => (prev?.upload.id === upload.id ? null : prev));
    setHandledElsewhere({ upload, decision });
  }, []);

  // Decided somewhere: refresh, and when it was another device's decision on
  // the file asked about here, say so rather than let the dialog vanish.
  useEffect(() => {
    const onDecided = (event: Event) => {
      const detail = (event as CustomEvent<SlicerDecidedDetail>).detail;
      refreshPending();
      if (!detail) return;
      if (detail.decision === 'restored') {
        const drop = (prev: Set<number>) => {
          const next = new Set(prev);
          next.delete(detail.file_id);
          return next;
        };
        setDecidedIds(drop);
        setPostponed(drop);
        return;
      }
      if (isOwnClaim(detail.claim)) return;
      const shown = printRequest?.upload.id === detail.file_id ? printRequest.upload : queued;
      if (shown?.id === detail.file_id && !handledElsewhere) {
        showHandledElsewhere(shown, detail.decision ?? null);
      } else {
        setDecidedIds((prev) => new Set(prev).add(detail.file_id));
      }
    };
    window.addEventListener(SLICER_DECIDED_EVENT, onDecided);
    return () => window.removeEventListener(SLICER_DECIDED_EVENT, onDecided);
  }, [refreshPending, printRequest, queued, handledElsewhere, showHandledElsewhere]);

  useEffect(() => {
    if (!handledElsewhere) return;
    const timer = setTimeout(() => setHandledElsewhere(null), HANDLED_ELSEWHERE_MS);
    return () => clearTimeout(timer);
  }, [handledElsewhere]);

  // A new file starts on the choice, with no error from the previous one.
  const currentId = current?.id ?? null;
  const [shownId, setShownId] = useState<number | null>(currentId);
  if (shownId !== currentId) {
    setShownId(currentId);
    setView('choose');
    setError(null);
  }

  const platesQuery = useQuery({
    queryKey: ['library-file-plates', currentId],
    queryFn: () => api.getLibraryFilePlates(currentId!),
    enabled: currentId !== null && !printRequest && !handledElsewhere,
  });
  const foldersQuery = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
    enabled: view === 'keep',
  });

  const plate = useMemo(() => {
    const plates = platesQuery.data?.plates ?? [];
    if (current?.plate != null) return plates.find((p) => p.index === current.plate) ?? null;
    return plates.length === 1 ? plates[0] : null;
  }, [platesQuery.data, current?.plate]);

  const targets = useMemo(() => keepTargets(foldersQuery.data, current?.folder_id ?? null), [foldersQuery.data, current?.folder_id]);

  const setAsideCurrent = useCallback(() => {
    if (handledElsewhere) {
      setHandledElsewhere(null);
      return;
    }
    if (!current) return;
    setPostponed((prev) => new Set(prev).add(current.id));
  }, [current, handledElsewhere]);

  const decided = useCallback(
    (upload: PendingSlicerUpload) => {
      setDecidedIds((prev) => new Set(prev).add(upload.id));
      refreshPending();
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    },
    [queryClient, refreshPending],
  );

  /**
   * Right before an action: does the file still wait? Another device may have
   * decided it a moment ago, with the message on its way.
   */
  const stillPending = async (upload: PendingSlicerUpload): Promise<boolean> => {
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: SLICER_INBOX_QUERY_KEY,
        queryFn: slicerInboxApi.getPending,
        staleTime: 0,
      });
      if (fresh.some((u) => u.id === upload.id)) return true;
    } catch {
      // Unknown: let the action go ahead, the server refuses a second decision.
      return true;
    }
    showHandledElsewhere(upload, null);
    return false;
  };

  const openQueueDialog = (upload: PendingSlicerUpload, claim: string) =>
    setPrintRequest({ upload, claim, scheduleOptions: { scheduleType: 'queue', requireManualStart: manualStart } });

  const startPrint = async () => {
    if (!current) return;
    const upload = current;
    setBusy('print');
    setError(null);
    try {
      if (await stillPending(upload)) setPrintRequest({ upload, claim: newDecisionClaim() });
    } finally {
      setBusy(null);
    }
  };

  const addToQueue = async () => {
    if (!current) return;
    const upload = current;
    const claim = newDecisionClaim();
    const item = quickQueueItem(upload, manualStart, claim);
    if (!item) {
      showToast(t('slicerInbox.noModel'), 'warning');
      openQueueDialog(upload, claim);
      return;
    }
    setBusy('queue');
    setError(null);
    try {
      if (!(await stillPending(upload))) return;
      await api.addToQueue(item);
      showToast(t('slicerInbox.queued', { model: upload.sliced_for_model }), 'success');
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      decided(upload);
    } catch (err) {
      if (isConflict(err)) {
        refreshPending();
        showHandledElsewhere(upload, 'queued');
      } else {
        showToast(t('slicerInbox.queueFailed', { reason: errorText(err) }), 'warning');
        openQueueDialog(upload, claim);
      }
    } finally {
      setBusy(null);
    }
  };

  const startKeep = () => {
    if (!current) return;
    const last = readLastFolder();
    setKeepFolderId(last !== null && last !== current.folder_id ? last : null);
    setKeepName(current.filename);
    setError(null);
    setView('keep');
  };

  // The remembered folder may be gone or no longer writable.
  useEffect(() => {
    if (view !== 'keep' || keepFolderId === null || !foldersQuery.data) return;
    if (!targets.some((option) => option.id === keepFolderId)) setKeepFolderId(null);
  }, [view, keepFolderId, foldersQuery.data, targets]);

  const keep = async () => {
    if (!current) return;
    const upload = current;
    const name = keepName.trim();
    if (!name) return;
    setBusy('keep');
    setError(null);
    try {
      if (!(await stillPending(upload))) return;
      if (name !== upload.filename) {
        await api.updateLibraryFile(upload.id, { filename: name });
      }
      const result = (await api.moveLibraryFiles([upload.id], keepFolderId)) as {
        moved: number;
        skipped_reasons?: { reason?: string }[];
      };
      if (!result.moved) {
        throw new Error(result.skipped_reasons?.[0]?.reason || t('slicerInbox.notMoved'));
      }
      storeLastFolder(keepFolderId);
      // The other sessions are told; a failure here only means they find out later.
      slicerInboxApi.announceKept(upload.id, newDecisionClaim()).catch(() => {});
      const target = targets.find((o) => o.id === keepFolderId);
      const folderName = keepFolderId === null ? t('slicerInbox.libraryRoot') : target ? folderPathLabel(target) : '';
      showToast(t('slicerInbox.kept', { folder: folderName }), 'success');
      decided(upload);
    } catch (err) {
      setError(t('slicerInbox.keepFailed', { reason: errorText(err) }));
    } finally {
      setBusy(null);
    }
  };

  const undoDiscard = async (upload: PendingSlicerUpload, claim: string) => {
    try {
      await slicerInboxApi.restore(upload.id, claim);
      setDecidedIds((prev) => {
        const next = new Set(prev);
        next.delete(upload.id);
        return next;
      });
      refreshPending();
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      showToast(t('slicerInbox.restored'), 'success');
    } catch (err) {
      showToast(t('slicerInbox.restoreFailed', { reason: errorText(err) }), 'error');
    }
  };

  const discard = async () => {
    if (!current) return;
    const upload = current;
    const claim = newDecisionClaim();
    setBusy('discard');
    setError(null);
    try {
      if (!(await stillPending(upload))) return;
      await slicerInboxApi.discard(upload.id, claim);
      const toastId = `slicer-discard-${upload.id}-${claim}`;
      showPersistentToast(toastId, t('slicerInbox.discarded'), 'success', {
        action: { label: t('slicerInbox.undo'), onClick: () => void undoDiscard(upload, claim) },
      });
      setTimeout(() => dismissToast(toastId), UNDO_DISCARD_MS);
      decided(upload);
    } catch (err) {
      if (isConflict(err)) {
        refreshPending();
        showHandledElsewhere(upload, 'queued');
      } else {
        setError(t('slicerInbox.discardFailed', { reason: errorText(err) }));
      }
    } finally {
      setBusy(null);
    }
  };

  if (printRequest) {
    const { upload, scheduleOptions, claim } = printRequest;
    return (
      <PrintModal
        mode="create"
        libraryFileId={upload.id}
        archiveName={upload.filename}
        preselectPlateId={upload.plate}
        initialScheduleOptions={scheduleOptions}
        cleanupLibraryAfterDispatch
        slicerInboxClaim={claim}
        onClose={() => setPrintRequest(null)}
        onSuccess={() => {
          setPrintRequest(null);
          queryClient.invalidateQueries({ queryKey: ['queue'] });
          decided(upload);
        }}
      />
    );
  }

  if (!current) {
    // Put off with "Later": a small button brings the files back, so an
    // always-open phone does not lose them until the next reload.
    if (postponedWaiting.length === 0) return null;
    return (
      <button
        type="button"
        onClick={() => setPostponed(new Set())}
        className="fixed z-40 right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] flex items-center gap-2 rounded-full border border-bambu-green/60 bg-bambu-dark-secondary px-4 py-2 text-sm text-white shadow-lg hover:bg-bambu-dark any-pointer-coarse:min-h-[44px]"
      >
        <Send className="w-4 h-4 text-bambu-green" />
        {t('slicerInbox.waitingIndicator', { count: postponedWaiting.length })}
      </button>
    );
  }

  const thumbnail = plate?.has_thumbnail
    ? api.getLibraryFilePlateThumbnail(current.id, plate.index)
    : api.getLibraryFileThumbnailUrl(current.id);
  const printTime = plate?.print_time_seconds ?? current.print_time_seconds;
  const grams = plate?.filament_used_grams ?? current.filament_used_grams;
  const filaments = plate?.filaments ?? [];
  const printFirst = current.print;
  const noPermission = t('slicerInbox.noPermission');
  const locked = !!busy || !!handledElsewhere;

  return (
    <DialogShell
      busy={!!busy}
      onEscape={() => (view === 'keep' ? setView('choose') : setAsideCurrent())}
      onBackdrop={setAsideCurrent}
    >
      <div
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="slicer-import-title"
        className="outline-none w-full max-w-lg max-h-[92vh] flex flex-col bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-bambu-dark-tertiary flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <Send className="w-5 h-5 text-bambu-green flex-shrink-0" />
            <div className="min-w-0">
              <h2 id="slicer-import-title" className="text-lg font-semibold text-white truncate">
                {t('slicerInbox.title')}
              </h2>
              {waiting.length > 1 && !handledElsewhere && (
                <p className="text-xs text-bambu-gray">
                  {t('slicerInbox.position', { current: position, total: waiting.length })}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={setAsideCurrent}
            disabled={!!busy}
            className="p-1.5 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark disabled:opacity-50 inline-flex items-center justify-center any-pointer-coarse:min-h-[44px] any-pointer-coarse:min-w-[44px]"
            aria-label={t('slicerInbox.later')}
            title={t('slicerInbox.later')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* The body scrolls; the actions below stay on screen. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* What came in */}
          <div className="flex gap-4 p-4">
            <div className="w-28 h-28 flex-shrink-0 flex items-center justify-center overflow-hidden rounded-lg bg-bambu-dark-tertiary">
              {failedThumbnail === thumbnail ? (
                <FileBox className="w-8 h-8 text-bambu-gray" />
              ) : (
                <img
                  src={thumbnail}
                  alt=""
                  className="h-full w-full object-contain"
                  onError={() => setFailedThumbnail(thumbnail)}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="font-medium text-white break-words">{current.filename}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-bambu-gray">
                {current.sliced_for_model && (
                  <span className="rounded-full border border-bambu-dark-tertiary px-2 py-0.5">
                    {t('slicerInbox.slicedFor', { model: current.sliced_for_model })}
                  </span>
                )}
                {current.plate != null && <span>{t('slicerInbox.plate', { plate: current.plate })}</span>}
                {printTime ? (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {formatDuration(printTime)}
                  </span>
                ) : null}
                {grams ? (
                  <span className="flex items-center gap-1">
                    <Weight className="w-3.5 h-3.5" />
                    {Math.round(grams)} g
                  </span>
                ) : null}
              </div>
              {filaments.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 pt-1" aria-label={t('slicerInbox.filaments')}>
                  {filaments.map((f) => (
                    <li
                      key={f.slot_id}
                      className="flex items-center gap-1.5 rounded-md bg-bambu-dark px-2 py-1 text-xs text-white"
                    >
                      <span
                        className="w-3 h-3 rounded-full border border-white/20"
                        style={{ backgroundColor: f.color?.startsWith('#') ? f.color : `#${f.color ?? '888888'}` }}
                      />
                      {f.type}
                      {f.used_grams ? <span className="text-bambu-gray">{Math.round(f.used_grams)} g</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {printFirst && (
                <p className="text-xs text-bambu-green">{t('slicerInbox.printRequested')}</p>
              )}
            </div>
          </div>

          {handledElsewhere && (
            <div
              role="status"
              className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-bambu-green/40 bg-bambu-green/10 px-3 py-2 text-sm text-white"
            >
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-bambu-green" />
              <span className="flex-1">
                {t(`slicerInbox.handledElsewhere.${handledElsewhere.decision ?? 'gone'}`)}
              </span>
            </div>
          )}

          {error && (
            <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="flex-1">{error}</span>
            </div>
          )}

          {view === 'keep' && !handledElsewhere && (
            <form
              id="slicer-keep-form"
              className="space-y-3 px-4 pb-4"
              onSubmit={(e) => {
                e.preventDefault();
                void keep();
              }}
            >
              <label className="block">
                <span className="block text-sm text-bambu-gray mb-1">{t('slicerInbox.folder')}</span>
                <select
                  value={keepFolderId ?? ''}
                  onChange={(e) => setKeepFolderId(e.target.value ? Number(e.target.value) : null)}
                  disabled={!!busy || foldersQuery.isLoading}
                  className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-bambu-green"
                >
                  <option value="">{t('slicerInbox.libraryRoot')}</option>
                  {targets.map((option) => (
                    <option key={option.id} value={option.id}>
                      {folderPathLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-sm text-bambu-gray mb-1">{t('slicerInbox.filename')}</span>
                <input
                  type="text"
                  value={keepName}
                  onChange={(e) => setKeepName(e.target.value)}
                  disabled={!!busy}
                  className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-bambu-green"
                />
              </label>
            </form>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-bambu-dark-tertiary px-4 py-3">
          {handledElsewhere ? (
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => setHandledElsewhere(null)}>
                {t('slicerInbox.handledElsewhereOk')}
              </Button>
            </div>
          ) : view === 'choose' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <ChoiceButton
                primary={printFirst}
                icon={busy === 'print' ? <Loader2 className="w-5 h-5 animate-spin" /> : <PrinterIcon className="w-5 h-5" />}
                label={t('slicerInbox.print')}
                hint={t('slicerInbox.printHint')}
                disabled={!canQueue || locked}
                reason={canQueue ? undefined : noPermission}
                onClick={() => void startPrint()}
              />
              <ChoiceButton
                icon={busy === 'queue' ? <Loader2 className="w-5 h-5 animate-spin" /> : <ListPlus className="w-5 h-5" />}
                label={t('slicerInbox.queue')}
                hint={
                  current.sliced_for_model
                    ? t('slicerInbox.queueHint', { model: current.sliced_for_model })
                    : t('slicerInbox.queueHintNoModel')
                }
                disabled={!canQueue || locked}
                reason={canQueue ? undefined : noPermission}
                onClick={() => void addToQueue()}
              />
              <ChoiceButton
                primary={!printFirst}
                icon={<FolderInput className="w-5 h-5" />}
                label={t('slicerInbox.keep')}
                hint={t('slicerInbox.keepHint')}
                disabled={!canKeep || locked}
                reason={canKeep ? undefined : noPermission}
                onClick={startKeep}
              />
              <ChoiceButton
                danger
                icon={busy === 'discard' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                label={t('slicerInbox.discard')}
                hint={t('slicerInbox.discardHint')}
                disabled={!canDiscard || locked}
                reason={canDiscard ? undefined : noPermission}
                onClick={() => void discard()}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setView('choose')} disabled={!!busy}>
                <ArrowLeft className="w-4 h-4" />
                {t('slicerInbox.back')}
              </Button>
              <Button type="submit" form="slicer-keep-form" size="sm" disabled={!!busy || !keepName.trim()}>
                {busy === 'keep' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderInput className="w-4 h-4" />}
                {t('slicerInbox.save')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

/**
 * The overlay, in a component of its own: the dialog above is mounted all
 * the time (Layout), the modal layer only while a file is asked about.
 */
function DialogShell({
  busy,
  onEscape,
  onBackdrop,
  children,
}: {
  busy: boolean;
  onEscape: () => void;
  onBackdrop: () => void;
  children: ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useModalBehavior(onEscape, overlayRef, busy);
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-2 sm:p-4"
      onClick={() => !busy && onBackdrop()}
    >
      {children}
    </div>
  );
}

interface ChoiceButtonProps {
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it cannot be used, shown in place of the hint. */
  reason?: string;
  primary?: boolean;
  danger?: boolean;
}

function ChoiceButton({ icon, label, hint, onClick, disabled, reason, primary, danger }: ChoiceButtonProps) {
  const tone = primary
    ? 'border-bambu-green bg-bambu-green/15 text-white enabled:hover:bg-bambu-green/25'
    : danger
      ? 'border-bambu-dark-tertiary bg-bambu-dark/60 text-white enabled:hover:border-red-500/60 enabled:hover:bg-red-500/10'
      : 'border-bambu-dark-tertiary bg-bambu-dark/60 text-white enabled:hover:border-bambu-green/60 enabled:hover:bg-bambu-dark';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
    >
      <span className={`mt-0.5 flex-shrink-0 ${danger ? 'text-red-400' : 'text-bambu-green'}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {reason ? (
          <span className="block text-xs text-amber-400">{reason}</span>
        ) : (
          <span className="block text-xs text-bambu-gray">{hint}</span>
        )}
      </span>
    </button>
  );
}
