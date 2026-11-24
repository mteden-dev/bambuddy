import { useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, ImageOff, Loader2, Pencil, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Permission, ProductQcJob } from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { PieceStepper } from './PieceStepper';
import { useToast } from '../../contexts/ToastContext';
import { useUiSettings } from '../../hooks/useUiSettings';
import { useUndoToast } from '../../hooks/useUndoToast';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { formatDateTime, formatRelativeTime, parseUTCDate } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';

// part id -> bad pieces
type Bad = Record<number, number>;

// Bigger tap targets on a touch screen (an iPad at a printer), whatever its width.
const TOUCH = 'pointer-coarse:min-h-11!';
// Finished prints wait this long on the list (the backend's QC window).
const WINDOW_DAYS = 7;
// A plate finished this recently is likely still too warm to judge.
const FRESH_MS = 10 * 60_000;

function rejectedOf(bad: Bad | undefined) {
  return Object.entries(bad ?? {})
    .filter(([, n]) => n > 0)
    .map(([partId, pieces]) => ({ part_id: Number(partId), pieces }));
}

function rejectedFromJob(job: ProductQcJob): Bad {
  return Object.fromEntries(job.pieces.filter((p) => p.rejected > 0).map((p) => [p.part_id, p.rejected]));
}

/** What a check changes: the lists, the products, Base orders and the queue it may have replanned. */
function useAfterCheck() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['product'] });
    queryClient.invalidateQueries({ queryKey: ['base-sync'] });
    queryClient.invalidateQueries({ queryKey: ['queue'] });
  };
}

/** Check a job, with "Undo" on the toast; ``onChecked`` runs after a successful check. */
function useCheckJob(job: ProductQcJob, source: 'dialog' | 'plate_clear' = 'dialog') {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const undoToast = useUndoToast();
  const afterCheck = useAfterCheck();
  const undo = useMutation({
    mutationFn: () => api.uncheckProductJob(job.id),
    onSuccess: () => {
      afterCheck();
      showToast(t('products.qc.undone'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  return useMutation({
    mutationFn: (bad: Bad) => api.checkProductJob(job.id, rejectedOf(bad), source),
    onSuccess: (result) => {
      afterCheck();
      undoToast(t(result.replanned ? 'products.qc.savedReplanned' : 'products.qc.saved'), () => undo.mutate());
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
}

function PlateThumb({ job }: { job: ProductQcJob }) {
  const [broken, setBroken] = useState(false);
  if (job.library_file_id == null || broken) {
    return (
      <div className="w-16 h-16 rounded-lg bg-bambu-dark flex items-center justify-center shrink-0">
        <ImageOff className="w-5 h-5 text-bambu-gray" />
      </div>
    );
  }
  return (
    <img
      src={api.getLibraryFileThumbnailUrl(job.library_file_id)}
      alt=""
      onError={() => setBroken(true)}
      className="w-16 h-16 rounded-lg object-cover bg-bambu-dark shrink-0"
    />
  );
}

/** Who printed it, when, and from which plate: enough to find the right plate on the bench. */
function JobHeader({ job, showExpiry }: { job: ProductQcJob; showExpiry: boolean }) {
  const { t } = useTranslation();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  const finished = parseUTCDate(job.finished_at);
  const daysLeft = finished
    ? Math.max(0, Math.ceil(WINDOW_DAYS - (Date.now() - finished.getTime()) / 86_400_000))
    : null;
  return (
    <div className="flex gap-3 min-w-0">
      <PlateThumb job={job} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {job.printer_name && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-bambu-green/15 text-bambu-green">
              {job.printer_name}
            </span>
          )}
          <span className="text-white font-medium truncate">{job.product_name}</span>
        </div>
        {job.finished_at && (
          <div className="text-xs text-bambu-gray-light mt-0.5" title={formatDateTime(job.finished_at, timeFormat)}>
            {formatRelativeTime(job.finished_at, timeFormat, t)}
            {showExpiry && daysLeft !== null && ` · ${t('products.qc.expiresIn', { days: daysLeft })}`}
          </div>
        )}
        {job.filename && <div className="text-xs text-bambu-gray truncate">{job.filename}</div>}
      </div>
    </div>
  );
}

function BadPieces({ job, bad, onChange, disabled }: { job: ProductQcJob; bad: Bad; onChange: (bad: Bad) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="mt-3 space-y-2">
      {job.pieces.map((piece) => (
        <li key={piece.part_id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-bambu-gray-light flex-1 min-w-0 truncate">
            {t('products.qc.printed', { part: piece.part_name, n: piece.pieces })}
          </span>
          <span className="text-xs text-bambu-gray">{t('products.qc.bad')}</span>
          <PieceStepper
            label={t('products.qc.badLabel', { part: piece.part_name })}
            tone="danger"
            max={piece.pieces}
            value={bad[piece.part_id] ?? 0}
            disabled={disabled}
            onChange={(n) => onChange({ ...bad, [piece.part_id]: n })}
          />
        </li>
      ))}
    </ul>
  );
}

/** One finished print in the list: check it, or (checked already) see and correct the answer. */
function QcJobCard({ job, canAct }: { job: ProductQcJob; canAct: boolean }) {
  const { t } = useTranslation();
  const checked = job.checked_at != null;
  const [editing, setEditing] = useState(!checked);
  const [bad, setBad] = useState<Bad>(() => rejectedFromJob(job));
  const check = useCheckJob(job);
  const anyBad = rejectedOf(bad).length > 0;
  const result = rejectedOf(rejectedFromJob(job));

  return (
    <Card className="p-3">
      <JobHeader job={job} showExpiry={!checked} />
      {editing ? (
        <>
          <BadPieces job={job} bad={bad} onChange={setBad} disabled={!canAct || check.isPending} />
          {canAct && (
            <div className="flex justify-end gap-2 mt-3">
              {checked && (
                <Button size="sm" variant="ghost" className={TOUCH} onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </Button>
              )}
              <Button
                size="sm"
                variant={anyBad ? 'danger' : 'primary'}
                className={TOUCH}
                onClick={() => check.mutate(bad, { onSuccess: () => checked && setEditing(false) })}
                disabled={check.isPending}
              >
                {check.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : !anyBad && <CheckCircle2 className="w-4 h-4" />}
                {t(anyBad ? 'products.qc.saveBad' : 'products.qc.allGood')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span
            className={`text-sm font-medium ${result.length ? 'text-red-500 dark:text-red-400' : 'text-bambu-green'}`}
          >
            {result.length
              ? t('products.qc.resultBad', {
                  list: job.pieces
                    .filter((p) => p.rejected > 0)
                    .map((p) => `${p.part_name} ${p.rejected}`)
                    .join(', '),
                })
              : t('products.qc.resultGood')}
          </span>
          {canAct && (
            <Button size="sm" variant="secondary" className={`${TOUCH} ml-auto`} onClick={() => setEditing(true)}>
              <Pencil className="w-4 h-4" />
              {t('products.qc.correct')}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="text-center py-12 text-red-500 dark:text-red-400">
      <p className="mb-3">{t('products.qc.loadFailed')}</p>
      <Button variant="secondary" className={TOUCH} onClick={onRetry}>
        {t('products.qc.retry')}
      </Button>
    </div>
  );
}

const chip = (active: boolean) =>
  `text-sm px-3.5 py-1.5 pointer-coarse:py-2.5 rounded-full border transition-colors ${
    active
      ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
      : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-gray'
  }`;

/**
 * Fork (products): finished prints of products to check, and the ones checked
 * lately (to correct an answer). Pieces count as good until marked bad; bad
 * ones leave stock and are printed again, and an order that closed with one
 * opens again.
 */
export function ProductQcView({ hasPermission }: { hasPermission: (p: Permission) => boolean }) {
  const { t } = useTranslation();
  const canAct = hasPermission('queue:create' as Permission);
  const [view, setView] = useState<'pending' | 'checked'>('pending');
  const [printer, setPrinter] = useState<number | null>(null);
  const pending = useQuery({
    queryKey: ['products', 'qc'],
    queryFn: () => api.getProductsToCheck(),
    refetchInterval: 60_000,
  });
  const checked = useQuery({
    queryKey: ['products', 'qc', 'checked'],
    queryFn: () => api.getProductsToCheck(undefined, { checked: true }),
    enabled: view === 'checked',
  });
  const current = view === 'pending' ? pending : checked;
  const jobs = useMemo(() => current.data ?? [], [current.data]);
  const printers = useMemo(() => {
    const seen = new Map<number, { name: string; count: number }>();
    for (const job of jobs) {
      if (job.printer_id == null) continue;
      const entry = seen.get(job.printer_id) ?? { name: job.printer_name ?? `#${job.printer_id}`, count: 0 };
      entry.count += 1;
      seen.set(job.printer_id, entry);
    }
    return [...seen].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [jobs]);
  const shown = printer == null ? jobs : jobs.filter((job) => job.printer_id === printer);
  const groups = printer == null && printers.length > 1
    ? printers.map(([id, { name }]) => ({ id, name, jobs: shown.filter((job) => job.printer_id === id) }))
    : [{ id: printer ?? 0, name: null as string | null, jobs: shown }];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-lg border border-bambu-dark-tertiary overflow-hidden" role="tablist">
          {(['pending', 'checked'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => {
                setView(value);
                setPrinter(null);
              }}
              className={`text-sm px-4 py-2 pointer-coarse:py-3 transition-colors ${
                view === value ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray-light hover:bg-bambu-dark-tertiary'
              }`}
            >
              {value === 'pending'
                ? t('products.qc.pendingTab', { count: pending.data?.length ?? 0 })
                : t('products.qc.checkedTab')}
            </button>
          ))}
        </div>
        <p className="text-xs text-bambu-gray flex-1 min-w-[12rem]">
          {t(view === 'pending' ? 'products.qc.hint' : 'products.qc.checkedHint')}
        </p>
      </div>
      {printers.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          <button type="button" className={chip(printer == null)} onClick={() => setPrinter(null)}>
            {t('products.qc.allPrinters')}
          </button>
          {printers.map(([id, { name, count }]) => (
            <button key={id} type="button" className={chip(printer === id)} onClick={() => setPrinter(id)}>
              {name} ({count})
            </button>
          ))}
        </div>
      )}
      {current.isLoading ? (
        <div className="text-center py-12 text-bambu-gray">{t('common.loading')}</div>
      ) : current.isError ? (
        <ErrorState onRetry={() => current.refetch()} />
      ) : !shown.length ? (
        <div className="text-center py-12 text-bambu-gray">
          <ClipboardCheck className="w-10 h-10 mx-auto mb-3 opacity-60" />
          {t(view === 'pending' ? 'products.qc.empty' : 'products.qc.emptyChecked')}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.id}>
              {group.name && <h3 className="text-sm font-semibold text-white mb-2">{group.name}</h3>}
              <div className="grid gap-2 lg:grid-cols-2">
                {group.jobs.map((job) => (
                  <QcJobCard key={`${job.id}-${job.checked_at ?? ''}`} job={job} canAct={canAct} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

interface PlateQcModalProps {
  /** The job on the plate now. */
  job: ProductQcJob;
  /** Older prints of this printer still waiting to be checked (not answered here). */
  olderCount: number;
  printerName: string | null;
  /** Close; the plate stays as it is. */
  onClose: () => void;
  /** Clear the plate (checked, or left for later). */
  onDone: () => void;
}

/**
 * Fork (products): before a plate is cleared, ask whether the products on it
 * are good. Only that plate: prints set aside earlier wait in the list. On a
 * touch screen it is a sheet at the bottom with full-width buttons.
 */
export function PlateQcModal({ job, olderCount, printerName, onClose, onDone }: PlateQcModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [bad, setBad] = useState<Bad>({});
  const anyBad = rejectedOf(bad).length > 0;
  // Still warm: "later" is the main answer.
  const [fresh] = useState(() => Date.now() - (parseUTCDate(job.finished_at)?.getTime() ?? 0) < FRESH_MS);
  const check = useCheckJob(job, 'plate_clear');
  useModalBehavior(onClose, dialogRef, check.isPending);

  const checkButton = (
    <Button
      data-autofocus={!fresh || anyBad ? true : undefined}
      variant={anyBad ? 'danger' : fresh ? 'secondary' : 'primary'}
      className={`${TOUCH} w-full pointer-fine:sm:w-auto`}
      onClick={() => check.mutate(bad, { onSuccess: onDone })}
      disabled={check.isPending}
    >
      {check.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
      {t(anyBad ? 'products.qc.saveBadAndClear' : 'products.qc.allGoodAndClear')}
    </Button>
  );
  const laterButton = (
    <Button
      data-autofocus={fresh && !anyBad ? true : undefined}
      variant={fresh && !anyBad ? 'primary' : 'secondary'}
      className={`${TOUCH} w-full pointer-fine:sm:w-auto`}
      onClick={onDone}
      disabled={check.isPending}
    >
      {t('products.qc.laterAndClear')}
    </Button>
  );

  return createPortal(
    // Clicks stay here: the printer card underneath reacts to clicks of its own.
    <div
      className="fixed inset-0 bg-black/50 flex items-center pointer-coarse:items-end justify-center z-50 p-4 pointer-coarse:px-2 pointer-coarse:pb-0"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg max-h-[90dvh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl pointer-coarse:rounded-b-none shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-bambu-dark-tertiary shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardCheck className="w-5 h-5 text-bambu-green shrink-0" />
            <h2 id={titleId} className="text-lg font-semibold text-white truncate">
              {printerName ? t('products.qc.plateTitleOn', { printer: printerName }) : t('products.qc.plateTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-3 -m-2 text-bambu-gray hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto min-h-0">
          <JobHeader job={job} showExpiry={false} />
          <BadPieces job={job} bad={bad} onChange={setBad} disabled={check.isPending} />
          {fresh && <p className="text-xs text-bambu-gray mt-3">{t('products.qc.stillWarm')}</p>}
          {olderCount > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-300 mt-3">
              {t('products.qc.olderWaiting', { count: olderCount })}
            </p>
          )}
        </div>
        {/* Touch: three full-width buttons, one under another; a mouse: one row. */}
        <div className="flex flex-col pointer-fine:sm:flex-row-reverse gap-2 px-4 py-3 border-t border-bambu-dark-tertiary shrink-0">
          {fresh && !anyBad ? laterButton : checkButton}
          {fresh && !anyBad ? checkButton : laterButton}
          <Button variant="ghost" className={`${TOUCH} w-full pointer-fine:sm:w-auto pointer-fine:sm:mr-auto`} onClick={onClose} disabled={check.isPending}>
            {t('products.qc.cancelKeepPlate')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface PrinterQcModalProps {
  printerId: number;
  printerName: string | null;
  canAct: boolean;
  onClose: () => void;
}

/** Fork (products): a printer's prints waiting to be checked, each answered on its own (the plate stays). */
export function PrinterQcModal({ printerId, printerName, canAct, onClose }: PrinterQcModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(onClose, dialogRef);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['products', 'qc', 'printer', printerId],
    queryFn: () => api.getProductsToCheck(printerId),
  });
  const jobs = data ?? [];

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center pointer-coarse:items-end justify-center z-50 p-4 pointer-coarse:px-2 pointer-coarse:pb-0"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg max-h-[90dvh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl pointer-coarse:rounded-b-none shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-bambu-dark-tertiary shrink-0">
          <h2 id={titleId} className="text-lg font-semibold text-white truncate">
            {t('products.qc.printerTitle', { printer: printerName ?? `#${printerId}` })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-3 -m-2 text-bambu-gray hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-2 overflow-y-auto min-h-0">
          {isLoading ? (
            <div className="text-center py-8 text-bambu-gray">{t('common.loading')}</div>
          ) : isError ? (
            <ErrorState onRetry={() => refetch()} />
          ) : !jobs.length ? (
            <div className="text-center py-8 text-bambu-gray">{t('products.qc.empty')}</div>
          ) : (
            jobs.map((job) => <QcJobCard key={job.id} job={job} canAct={canAct} />)
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
