import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShoppingCart, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Product, ProductOrder, ProductPlanResult } from '../../api/client';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { NumberInput } from '../NumberInput';
import { parseUTCDate, toDateTimeLocalValue } from '../../utils/date';
import { invalidatePlanQueries } from '../../utils/products';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { useDiscardGuard } from './useDiscardGuard';

interface ProductOrderModalProps {
  product: Product;
  /** The open order to change; none for a new one. */
  order?: ProductOrder | null;
  onClose: () => void;
  onPlanned: (result: ProductPlanResult) => void;
}

// 16 px on a phone: a smaller field makes iOS zoom in on focus.
const inputClass =
  'w-full px-3 py-2 any-pointer-coarse:min-h-[44px] bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray text-base sm:text-sm focus:border-bambu-green focus:outline-none';
const TOUCH = 'any-pointer-coarse:min-h-[44px]!';

/** Fork (products): order some of a product, or change an open order; either replans. */
export function ProductOrderModal({ product, order, onClose, onPlanned }: ProductOrderModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(order?.quantity ?? 1);
  const [due, setDue] = useState(() => {
    const date = parseUTCDate(order?.due_date);
    return date ? toDateTimeLocalValue(date) : '';
  });
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const dueDate = due ? new Date(due).toISOString() : null;
      if (order) {
        return api.updateProductOrder(order.id, {
          quantity,
          due_date: dueDate,
          clear_due_date: !dueDate,
          notes: notes.trim() || null,
        });
      }
      return api.createProductOrder(product.id, { quantity, due_date: dueDate, notes: notes.trim() || null });
    },
    onSuccess: (result) => {
      // A plan can replan other products and Base orders too.
      invalidatePlanQueries(queryClient);
      onPlanned(result);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  // Planning takes seconds: the dialog stays until it answers, so nothing is sent twice unseen.
  const pending = mutation.isPending;

  // Escape asks before dropping changed fields; a sheet on a phone, so Back closes it too.
  const [baseline] = useState(() => JSON.stringify([quantity, due, notes]));
  const dirty = JSON.stringify([quantity, due, notes]) !== baseline;
  const { requestClose, confirm } = useDiscardGuard(dirty, onClose);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalBehavior(requestClose, overlayRef, { busy: pending, backCloses: 'narrow' });

  return (
    // A bottom sheet on a phone, a centred dialog from sm.
    <div ref={overlayRef} className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 sm:p-4">
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="outline-none w-full sm:max-w-md max-h-[90dvh] overflow-y-auto rounded-b-none sm:rounded-b-xl"
      >
        <CardContent className="p-0">
          <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
            <div className="flex items-center gap-2 min-w-0">
              <ShoppingCart className="w-5 h-5 text-bambu-green shrink-0" />
              <h2 id={titleId} className="text-lg font-semibold text-white truncate">
                {order ? t('products.order.editTitle', { name: product.name }) : t('products.order.newTitle', { name: product.name })}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="p-2 -m-2 any-pointer-coarse:min-h-[44px] any-pointer-coarse:min-w-[44px] flex items-center justify-center text-bambu-gray hover:text-white disabled:opacity-40"
              aria-label={t('common.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <form
            className="p-4 space-y-3 max-sm:any-pointer-coarse:pb-8"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              mutation.mutate();
            }}
          >
            <label className="block">
              <span className="block text-sm text-bambu-gray mb-1">{t('products.order.quantity')}</span>
              <NumberInput
                min={1}
                max={10000}
                fallback={1}
                className={inputClass}
                value={quantity}
                onChange={setQuantity}
                data-autofocus
              />
            </label>
            <label className="block">
              <span className="block text-sm text-bambu-gray mb-1">{t('products.order.dueDate')}</span>
              <input type="datetime-local" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="block">
              <span className="block text-sm text-bambu-gray mb-1">{t('products.order.notes')}</span>
              <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <p className="text-xs text-bambu-gray">{t('products.order.hint')}</p>
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
            {pending && (
              <p role="status" className="flex items-center gap-2 text-sm text-bambu-gray">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                {t('products.orderPlanning')}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" className={TOUCH} onClick={onClose} disabled={pending}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" className={TOUCH} disabled={pending}>
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}

                {order ? t('products.order.saveAndPlan') : t('products.order.addAndPlan')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {confirm}
    </div>
  );
}
