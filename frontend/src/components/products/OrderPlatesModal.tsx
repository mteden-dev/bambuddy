import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ImageOff, Loader2, Printer, X } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderPlate, BaseOrderPlateFilament } from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDuration } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import { shortWhen as when } from '../../utils/baseOrders';
import { PlateTime } from './PlateTime';

const TOUCH = 'pointer-coarse:min-h-[44px]!';
// 16 px on a phone: a smaller select makes iOS zoom in on focus.
const selectClass =
  'w-full sm:w-64 px-2 py-2 pointer-coarse:min-h-[44px] bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-base sm:text-sm focus:border-bambu-green focus:outline-none disabled:opacity-60';

interface OrderPlatesModalProps {
  order: BaseOrder;
  /** May set a preferred printer (queue:create). */
  canAct: boolean;
  onClose: () => void;
}

/** "lid_x2" from "lid_x2.gcode.3mf". */
function shortName(filename: string | null): string {
  return (filename ?? '').replace(/(\.gcode)?\.3mf$|\.gcode$/i, '') || '?';
}

function FilamentLine({ filament }: { filament: BaseOrderPlateFilament }) {
  const { t } = useTranslation();
  const label = `${filament.type} ${t('baseSync.plates.grams', { grams: Math.round(filament.grams) })}`;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span
        aria-hidden="true"
        className="w-3 h-3 rounded-full border border-white/30 shrink-0"
        style={{ backgroundColor: filament.color || 'transparent' }}
      />
      <span className="text-bambu-gray-light">{label}</span>
      {filament.left != null && (
        <span className="text-bambu-gray">{t('baseSync.plates.left', { grams: Math.round(filament.left) })}</span>
      )}
      {filament.swap && (
        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
          {filament.swap === 'load'
            ? t('baseSync.plates.swap.load', { filament: filament.type })
            : t('baseSync.plates.swap.change')}
        </span>
      )}
    </li>
  );
}

interface PlateCardProps {
  plate: BaseOrderPlate;
  orderLabel: string;
  canAct: boolean;
  /** A preference is being saved (for this plate: show it). */
  saving: boolean;
  savingThis: boolean;
  timeFormat: TimeFormat;
  onPrefer: (printerId: number | null) => void;
}

function PlateCard({ plate, orderLabel, canAct, saving, savingThis, timeFormat, onPrefer }: PlateCardProps) {
  const { t } = useTranslation();
  const name = shortName(plate.filename) + (plate.plate_index ? ` · ${t('baseSync.plates.plate', { n: plate.plate_index })}` : '');
  const nameOf = (id: number | null) =>
    id == null ? '' : (plate.printers.find((p) => p.id === id)?.name ?? (id === plate.printer_id ? plate.printer_name : null) ?? `#${id}`);
  const printer = plate.printer_name ?? nameOf(plate.printer_id);
  const where =
    plate.status === 'printing'
      ? t('baseSync.plates.printing', { printer, time: when(plate.end, timeFormat) })
      : plate.start && printer
        ? t('baseSync.plates.planned', {
            printer,
            start: when(plate.start, timeFormat),
            end: when(plate.end, timeFormat),
          })
        : printer || t('baseSync.plates.noPrinter');
  const others = plate.orders.filter((label) => label !== orderLabel);
  const overruled =
    plate.preferred_printer_id != null && plate.overruled
      ? t(`baseSync.plates.overruled.${plate.overruled}`, {
          printer,
          preferred: nameOf(plate.preferred_printer_id),
          time: formatDuration(plate.overruled_by_s),
        })
      : null;
  const selectId = `plate-pref-${plate.job_id}`;

  return (
    <li className="rounded-lg bg-bambu-dark/60 p-3">
      <div className="flex items-start gap-3">
        {plate.has_thumbnail && plate.library_file_id != null ? (
          <img
            src={api.getLibraryFileThumbnailUrl(plate.library_file_id)}
            alt=""
            loading="lazy"
            className="w-14 h-14 rounded-lg object-cover bg-bambu-dark shrink-0"
          />
        ) : (
          <div className="w-14 h-14 rounded-lg bg-bambu-dark flex items-center justify-center shrink-0">
            <ImageOff className="w-5 h-5 text-bambu-gray" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm text-white font-medium break-words">{name}</div>
          <div className="text-xs text-bambu-gray-light break-words">
            {plate.product_name} · {plate.pieces.map((p) => `${p.name} ×${p.pieces}`).join(' · ')}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-bambu-gray-light">
            <Printer aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
            <span className="break-words">{where}</span>
          </div>
          <PlateTime plate={plate} />
          {plate.filament.length > 0 && (
            <ul className="space-y-0.5">
              {plate.filament.map((filament, index) => (
                <FilamentLine key={`${filament.type}-${filament.color}-${index}`} filament={filament} />
              ))}
            </ul>
          )}
          {others.length > 0 && (
            <div className="text-xs text-bambu-gray">{t('baseSync.plates.alsoFor', { orders: others.join(', ') })}</div>
          )}
        </div>
      </div>

      {overruled && (
        <p role="status" className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {overruled}
        </p>
      )}

      {plate.editable && canAct ? (
        <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <label htmlFor={selectId} className="text-xs text-bambu-gray sm:w-40 shrink-0">
            {t('baseSync.plates.preferred')}
          </label>
          <div className="flex items-center gap-2 min-w-0">
            <select
              id={selectId}
              className={selectClass}
              value={plate.preferred_printer_id ?? ''}
              disabled={saving}
              aria-label={t('baseSync.plates.preferLabel', { name })}
              onChange={(e) => onPrefer(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{t('baseSync.plates.auto')}</option>
              {plate.printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.available ? p.name : t('baseSync.plates.unavailable', { name: p.name })}
                </option>
              ))}
            </select>
            {savingThis && <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin text-bambu-gray shrink-0" />}
          </div>
        </div>
      ) : (
        (plate.by_hand || plate.moved) && (
          <p className="mt-2 text-xs text-bambu-gray">
            {t(plate.by_hand ? 'baseSync.plates.byHand' : 'baseSync.plates.moved')}
          </p>
        )
      )}
      {plate.editable && canAct && plate.pinned && (
        <p className="mt-1 text-xs text-bambu-gray">{t('baseSync.plates.pinned')}</p>
      )}
    </li>
  );
}

/**
 * Fork (Base sync): the plates the plan prints for an order, opened after
 * sending it or from its row. Per plate: where and when it prints, the
 * filament it takes and what is left on the spool after it, and a preferred
 * printer ("Automatic" by default). A preference is a nudge the plan weighs
 * now and at every later replan; another printer still takes the plate when
 * it is done clearly sooner or has the filament the preferred one lacks.
 */
export function OrderPlatesModal({ order, canAct, onClose }: OrderPlatesModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  const plates = useQuery({
    queryKey: ['base-sync', 'plates', order.order_id],
    queryFn: () => api.getBaseOrderPlates(order.order_id),
    refetchInterval: 60_000,
  });
  const prefer = useMutation({
    mutationFn: ({ jobId, printerId }: { jobId: number; printerId: number | null }) =>
      api.setProductJobPreference(jobId, printerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['base-sync'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      showToast(t('baseSync.plates.saved'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // A sheet on a phone: Back closes it.
  const overlayRef = useRef<HTMLDivElement>(null);
  useModalBehavior(onClose, overlayRef, { backCloses: 'narrow' });

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <Card
        tabIndex={-1}
        className="outline-none w-full sm:max-w-2xl max-h-[92dvh] flex flex-col rounded-b-none sm:rounded-b-xl"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-plates-title"
      >
        <div className="flex items-start gap-3 p-4 border-b border-bambu-dark-tertiary">
          <div className="min-w-0 flex-1">
            <h3 id="order-plates-title" className="text-lg font-semibold text-white">
              {t('baseSync.plates.title')}
            </h3>
            <p className="text-sm text-bambu-gray truncate">{order.label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('baseSync.plates.close')}
            className="p-2 -m-2 text-bambu-gray hover:text-white pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-3 flex-1 min-h-0">
          {canAct && <p className="text-xs text-bambu-gray">{t('baseSync.plates.hint')}</p>}
          {plates.isLoading ? (
            <div className="space-y-2" aria-hidden="true">
              {[0, 1].map((i) => (
                <div key={i} className="h-24 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse" />
              ))}
            </div>
          ) : plates.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-500 dark:text-red-400">
              {t('baseSync.plates.loadFailed')}
              <Button size="sm" variant="secondary" className={TOUCH} onClick={() => plates.refetch()}>
                {t('products.qc.retry')}
              </Button>
            </div>
          ) : !plates.data?.length ? (
            <p className="text-sm text-bambu-gray py-6 text-center">{t('baseSync.plates.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {plates.data.map((plate) => (
                <PlateCard
                  key={plate.job_id}
                  plate={plate}
                  orderLabel={order.label}
                  canAct={canAct}
                  saving={prefer.isPending}
                  savingThis={prefer.isPending && prefer.variables?.jobId === plate.job_id}
                  timeFormat={timeFormat}
                  onPrefer={(printerId) => prefer.mutate({ jobId: plate.job_id, printerId })}
                />
              ))}
            </ul>
          )}
        </div>

        {/* A sheet on a touch phone: a fixed bottom padding keeps the button off the home-indicator
            zone (env(safe-area-inset-bottom) is 0 without viewport-fit=cover). */}
        <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end max-sm:any-pointer-coarse:pb-8">
          <Button className={`${TOUCH} w-full sm:w-auto`} onClick={onClose}>
            {t('baseSync.plates.done')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
