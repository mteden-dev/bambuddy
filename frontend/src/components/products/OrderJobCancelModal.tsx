import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, PackageCheck, RotateCcw, Undo2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductJobOrders, QueueJobCancelResult, QueueJobCancelThen } from '../../api/client';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { shipKind, urgentFirst } from '../../utils/baseOrders';
import { usePlanReport, withNote } from './usePlanReport';

const TOUCH = 'pointer-coarse:min-h-[44px]!';
const DOT: Record<string, string> = { allegro: 'bg-[#FF5A00]', shop: 'bg-sky-400' };

interface OrderJobCancelModalProps {
  itemId: number;
  /** The print's name, as the queue shows it. */
  name: string;
  /** The orders it prints for (GET /products/order-tags). */
  entry: ProductJobOrders;
  onClose: () => void;
}

const OPTIONS: { then: QueueJobCancelThen; icon: LucideIcon }[] = [
  { then: 'replan', icon: RotateCcw },
  { then: 'stock', icon: PackageCheck },
  { then: 'withdraw', icon: Undo2 },
];

/**
 * Fork (products): cancelling a waiting print the planner made for orders.
 * A plain cancel would leave its orders short with nothing in the queue to
 * make up for it, so this asks what becomes of its pieces: print them again,
 * they are on hand already, or withdraw the orders (all or some of them).
 */
export function OrderJobCancelModal({ itemId, name, entry, onClose }: OrderJobCancelModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const planNote = usePlanReport();
  const orders = urgentFirst(entry);
  const [then, setThen] = useState<QueueJobCancelThen | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(orders.map((o) => o.product_order_id)));

  const cancel = useMutation({
    mutationFn: () =>
      api.cancelOrderJob(itemId, {
        then: then as QueueJobCancelThen,
        ...(then === 'withdraw' ? { orders: [...chosen] } : {}),
      }),
    onSuccess: (result: QueueJobCancelResult) => {
      for (const key of ['queue', 'products', 'product', 'base-sync', 'batches']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      const labels = orders.filter((o) => chosen.has(o.product_order_id)).map((o) => o.label);
      showToast(
        withNote(
          then === 'withdraw'
            ? t('products.cancelJob.toast.withdrawn', { orders: labels.join(', ') })
            : then === 'stock'
              ? t('products.cancelJob.toast.stocked')
              : t('products.cancelJob.toast.replanned'),
          planNote(result),
        ),
        'success',
      );
      if (result.short.length) showToast(t('products.cancelJob.toast.short'), 'warning');
      onClose();
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const overlayRef = useRef<HTMLDivElement>(null);
  const requestClose = useModalBehavior(onClose, overlayRef, cancel.isPending);

  const toggle = (id: number) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ready = then !== null && (then !== 'withdraw' || chosen.size > 0);

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
        aria-labelledby="order-job-cancel-title"
      >
        <CardContent className="p-4 sm:p-6 space-y-4">
          <div>
            <h3 id="order-job-cancel-title" className="text-lg font-semibold text-white">
              {t('products.cancelJob.title')}
            </h3>
            <p className="text-sm text-bambu-gray break-words">{name}</p>
          </div>

          <div>
            <div className="text-xs text-bambu-gray mb-1.5">{t('products.cancelJob.printsFor')}</div>
            <div className="flex flex-wrap gap-1.5">
              {orders.map((tag) => {
                const kind = shipKind(tag.ship_by ?? tag.due ?? null);
                return (
                  <span
                    key={tag.product_order_id}
                    title={tag.title}
                    className={`inline-flex items-center gap-1.5 rounded-full bg-bambu-dark-tertiary px-2.5 py-1 text-sm ${
                      kind === 'late' ? 'text-red-400' : kind === 'today' ? 'text-amber-300' : 'text-white'
                    }`}
                  >
                    {tag.source_kind && <span className={`w-2 h-2 rounded-full ${DOT[tag.source_kind]}`} />}
                    {tag.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div role="radiogroup" aria-label={t('products.cancelJob.question')} className="space-y-2">
            <div className="text-sm text-white">{t('products.cancelJob.question')}</div>
            {OPTIONS.map(({ then: value, icon: Icon }) => {
              const selected = then === value;
              return (
                <div
                  key={value}
                  className={`rounded-lg border ${
                    selected
                      ? value === 'withdraw'
                        ? 'border-red-500/70 bg-red-500/10'
                        : 'border-bambu-green bg-bambu-green/10'
                      : 'border-bambu-dark-tertiary'
                  }`}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setThen(value)}
                    className="w-full flex items-start gap-3 p-3 text-left min-h-[44px]"
                  >
                    <Icon
                      aria-hidden="true"
                      className={`w-5 h-5 mt-0.5 shrink-0 ${selected ? (value === 'withdraw' ? 'text-red-400' : 'text-bambu-green') : 'text-bambu-gray'}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-white">
                        {t(`products.cancelJob.${value}.label`)}
                      </span>
                      <span className="block text-xs text-bambu-gray mt-0.5">
                        {t(
                          value === 'withdraw' && orders.length > 1
                            ? 'products.cancelJob.withdraw.hintMany'
                            : `products.cancelJob.${value}.hint`,
                        )}
                      </span>
                    </span>
                  </button>
                  {value === 'withdraw' && selected && orders.length > 1 && (
                    <div className="px-3 pb-3 space-y-1">
                      {orders.map((tag) => (
                        <label
                          key={tag.product_order_id}
                          className="flex items-center gap-3 min-h-[44px] text-sm text-white cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="w-5 h-5 accent-red-500"
                            checked={chosen.has(tag.product_order_id)}
                            onChange={() => toggle(tag.product_order_id)}
                          />
                          <span className="truncate">{tag.label}</span>
                          <span className="text-xs text-bambu-gray truncate">{tag.title}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex gap-3 pt-1">
            <Button variant="secondary" className={`flex-1 ${TOUCH}`} onClick={onClose} disabled={cancel.isPending}>
              {t('products.cancelJob.back')}
            </Button>
            <Button
              variant={then === 'withdraw' ? 'danger' : 'primary'}
              className={`flex-1 ${TOUCH}`}
              onClick={() => cancel.mutate()}
              disabled={!ready || cancel.isPending}
            >
              {cancel.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                t(then ? `products.cancelJob.${then}.button` : 'products.cancelJob.choose')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
