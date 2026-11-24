import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShoppingCart, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Product, ProductOrder, ProductPlanResult } from '../../api/client';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { NumberInput } from '../NumberInput';
import { parseUTCDate, toDateTimeLocalValue } from '../../utils/date';

interface ProductOrderModalProps {
  product: Product;
  /** The open order to change; none for a new one. */
  order?: ProductOrder | null;
  onClose: () => void;
  onPlanned: (result: ProductPlanResult) => void;
}

const inputClass =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray text-sm focus:border-bambu-green focus:outline-none';

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product', product.id] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      onPlanned(result);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-0">
          <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
            <div className="flex items-center gap-2 min-w-0">
              <ShoppingCart className="w-5 h-5 text-bambu-green shrink-0" />
              <h2 className="text-lg font-semibold text-white truncate">
                {order ? t('products.order.editTitle', { name: product.name }) : t('products.order.newTitle', { name: product.name })}
              </h2>
            </div>
            <button onClick={onClose} className="text-bambu-gray hover:text-white" aria-label={t('common.close')}>
              <X className="w-5 h-5" />
            </button>
          </div>
          <form
            className="p-4 space-y-3"
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
                autoFocus
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
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {order ? t('products.order.saveAndPlan') : t('products.order.addAndPlan')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
