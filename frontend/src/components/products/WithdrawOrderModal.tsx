import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseWithdrawPiece, BaseWithdrawPreview, BaseWithdrawPrint } from '../../api/client';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';

const TOUCH = 'any-pointer-coarse:min-h-[44px]!';

interface WithdrawOrderModalProps {
  order: BaseOrder;
  busy: boolean;
  onConfirm: (returnDone: boolean) => void;
  onCancel: () => void;
}

/** "lid_x2" from "lid_x2.gcode.3mf". */
function shortName(filename: string | null): string {
  return (filename ?? '').replace(/(\.gcode)?\.3mf$|\.gcode$/i, '') || '?';
}

function piecesText(pieces: BaseWithdrawPiece[]): string {
  return pieces.map((p) => `${p.name} ×${p.pieces}`).join(', ');
}

function PrintList({ title, prints }: { title: string; prints: BaseWithdrawPrint[] }) {
  if (!prints.length) return null;
  return (
    <div>
      <div className="text-xs text-bambu-gray mb-1">{title}</div>
      <ul className="space-y-1">
        {prints.map((print, index) => (
          <li key={print.queue_item_id ?? `p${index}`} className="text-sm text-white leading-snug">
            <span className="break-all">{shortName(print.filename)}</span>
            {print.printer_name && <span className="text-bambu-gray"> · {print.printer_name}</span>}
            {print.pieces.length > 0 && (
              <span className="block text-xs text-bambu-gray-light">{piecesText(print.pieces)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-bambu-dark-tertiary p-3 space-y-3">{children}</div>;
}

/**
 * Fork (Base sync): withdrawing an order from production says first what it
 * does, worked out by the server and taken back (POST .../skip/preview): the
 * waiting prints that leave the queue, plates queued instead for the orders
 * that shared one with it, prints that finish anyway, and what ends up in
 * stock. Products already done for it can go back on the shelf (stock).
 */
export function WithdrawOrderModal({ order, busy, onConfirm, onCancel }: WithdrawOrderModalProps) {
  const { t } = useTranslation();
  const [returnDone, setReturnDone] = useState(true);
  const preview = useQuery({
    queryKey: ['withdraw-preview', order.order_id, returnDone],
    queryFn: () => api.previewWithdrawBaseOrder(order.order_id, { return_done: returnDone }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    // The last answer stays on screen while the checkbox asks again.
    placeholderData: (previous) => previous,
  });

  const overlayRef = useRef<HTMLDivElement>(null);
  const requestClose = useModalBehavior(onCancel, overlayRef, busy);

  // The last preview that came stays on screen (and decides) while the checkbox asks again, even if that fails.
  const known = useRef<BaseWithdrawPreview | null>(null);
  if (preview.data) known.current = preview.data;
  const data = preview.data ?? known.current ?? undefined;
  // No preview at all (it failed): no box to show, so the operator's choice (default: yes) is sent as it is.
  const noPreview = !data && preview.isError;
  // Before the preview the confirm waits: it decides whether "put back in stock" applies.
  const ready = !!data || noPreview;
  const nothing =
    data && !data.removed.length && !data.added.length && !data.printing.length && !data.to_stock.length;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={requestClose}
    >
      <Card
        tabIndex={-1}
        className="outline-none w-full sm:max-w-md max-h-[90dvh] overflow-y-auto rounded-b-none sm:rounded-b-xl"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-order-title"
      >
        <CardContent className="p-4 sm:p-6 space-y-4">
          <h3 id="withdraw-order-title" className="text-lg font-semibold text-white">
            {t('baseSync.withdrawTitle', { number: order.label })}
          </h3>

          {!data && preview.isLoading && (
            <div role="status" className="flex items-center gap-2 text-sm text-bambu-gray">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('baseSync.withdrawPreview.loading')}
            </div>
          )}
          {!data && preview.isError && (
            <p className="text-sm text-amber-600 dark:text-amber-300">{t('baseSync.withdrawPreview.failed')}</p>
          )}

          {data && (
            <div className={`space-y-3 ${preview.isFetching ? 'opacity-60' : ''}`} aria-busy={preview.isFetching}>
              {(data.removed.length > 0 || data.added.length > 0 || data.printing.length > 0) && (
                <Section>
                  <PrintList title={t('baseSync.withdrawPreview.removed')} prints={data.removed} />
                  <PrintList title={t('baseSync.withdrawPreview.added')} prints={data.added} />
                  <PrintList title={t('baseSync.withdrawPreview.printing')} prints={data.printing} />
                </Section>
              )}
              {data.to_stock.length > 0 && (
                <p className="text-sm text-sky-700 dark:text-sky-300">
                  {t('baseSync.withdrawPreview.toStock', { parts: piecesText(data.to_stock) })}
                </p>
              )}
              {nothing && !data.done.length && (
                <p className="text-sm text-bambu-gray">{t('baseSync.withdrawPreview.nothing')}</p>
              )}
              {data.done.length > 0 && (
                <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 mt-0.5 shrink-0 accent-bambu-green"
                    checked={returnDone}
                    onChange={(e) => setReturnDone(e.target.checked)}
                  />
                  <span className="text-sm text-white">
                    {t('baseSync.withdrawPreview.returnDone', {
                      products: data.done.map((d) => `${d.units}× ${d.name}`).join(', '),
                    })}
                    <span className="block text-xs text-bambu-gray">{t('baseSync.withdrawPreview.returnDoneHint')}</span>
                  </span>
                </label>
              )}
            </div>
          )}

          <p className="text-xs text-bambu-gray">{t('baseSync.withdrawPreview.base')}</p>

          <div className="flex gap-3">
            <Button variant="secondary" className={`flex-1 ${TOUCH}`} onClick={onCancel} disabled={busy}>
              {t('products.cancelJob.back')}
            </Button>
            <Button
              variant="danger"
              className={`flex-1 ${TOUCH}`}
              onClick={() => onConfirm(data ? returnDone && data.done.length > 0 : returnDone)}
              disabled={busy || !ready}
            >
              {busy || !ready ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : noPreview ? (
                t('baseSync.withdrawNoPreview')
              ) : (
                t('baseSync.withdraw')
              )}

            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
