import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Info, Loader2, Printer, X } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderAcceptProduct } from '../../api/client';
import { Button } from '../Button';
import { PieceStepper } from './PieceStepper';
import { useModalBehavior } from '../../hooks/useModalBehavior';

interface AcceptOrderModalProps {
  order: BaseOrder;
  onClose: () => void;
  onDone: () => void;
}

interface Choice {
  units: number;
  // part id -> pieces on hand outside the stock Bambuddy counted before
  have: Record<number, number>;
  // The product's parts, once loaded: what is sent as on hand for it.
  parts?: number[];
}

/** Products an order's mapped lines want, with their names: product id -> {name, units}. */
function wantedProducts(order: BaseOrder): Map<number, { name: string; units: number }> {
  const wanted = new Map<number, { name: string; units: number }>();
  for (const line of order.lines) {
    if (line.mapping !== 'product' || line.product_id == null) continue;
    const entry = wanted.get(line.product_id) ?? { name: line.product_name ?? line.name, units: 0 };
    entry.units += line.quantity * line.units;
    wanted.set(line.product_id, entry);
  }
  return wanted;
}

/**
 * Fork (Base sync): send an order to production line by line, or change what an
 * accepted one prints: how many of each product, and which parts are on the
 * shelf already. Those go into stock (as a total for the order: changing it
 * later puts in or takes out only the difference), so only the rest is printed.
 */
export function AcceptOrderModal({ order, onClose, onDone }: AcceptOrderModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const wanted = useMemo(() => wantedProducts(order), [order]);
  const onHand = useMemo(
    () => Object.fromEntries(Object.entries(order.on_hand ?? {}).map(([k, v]) => [Number(k), v])),
    [order],
  );
  // Parts on hand belong to products; each card keeps the ones of its product.
  const [choices, setChoices] = useState<Record<number, Choice>>(() =>
    Object.fromEntries(
      [...wanted].map(([id, { units }]) => [
        id,
        { units: Math.max(0, units - (order.held?.[String(id)] ?? 0)), have: { ...onHand } },
      ]),
    ),
  );
  const accepted = order.state === 'accepted';

  const mutation = useMutation({
    mutationFn: () => {
      const products: BaseOrderAcceptProduct[] = Object.entries(choices).map(([id, choice]) => ({
        product_id: Number(id),
        units: choice.units,
        have: Object.entries(choice.have)
          .filter(([partId, pieces]) => pieces > 0 && (choice.parts ?? []).includes(Number(partId)))
          .map(([partId, pieces]) => ({ part_id: Number(partId), pieces })),
      }));
      return api.acceptBaseOrder(order.order_id, { products });
    },
    onSuccess: onDone,
  });
  useModalBehavior(onClose, dialogRef, mutation.isPending);
  // On hand is a total for the order: sent only once every product's parts are known.
  const ready = Object.values(choices).every((choice) => choice.parts !== undefined);

  const other = order.lines.filter((line) => line.mapping !== 'product');
  const setChoice = (id: number, patch: Partial<Choice>) =>
    setChoices((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const summary = [...wanted]
    .filter(([id]) => (choices[id]?.units ?? 0) > 0)
    .map(([id, { name }]) => `${choices[id].units} × ${name}`)
    .join(', ');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center pointer-coarse:items-end justify-center z-50 p-4 pointer-coarse:px-2 pointer-coarse:pb-0">
      <form
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending && ready && wanted.size > 0) mutation.mutate();
        }}
        className="w-full max-w-xl max-h-[90dvh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl pointer-coarse:rounded-b-none shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-bambu-dark-tertiary shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Printer className="w-5 h-5 text-bambu-green shrink-0" />
            <h2 id={titleId} className="text-lg font-semibold text-white truncate">
              {t(accepted ? 'baseSync.acceptModal.changeTitle' : 'baseSync.acceptModal.title', {
                number: order.number ?? order.order_id,
              })}
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
        <div className="p-4 space-y-4 overflow-y-auto min-h-0">
          <HintWithDetails short={t('baseSync.acceptModal.hint')} details={t('baseSync.acceptModal.hintDetails')} />
          {[...wanted].map(([id, { name, units }]) => (
            <ProductChoiceCard
              key={id}
              productId={id}
              name={name}
              wanted={units}
              choice={choices[id]}
              onChange={(patch) => setChoice(id, patch)}
            />
          ))}
          {other.length > 0 && (
            <div className="text-xs text-bambu-gray space-y-0.5">
              <div>{t('baseSync.acceptModal.otherLines')}</div>
              {other.map((line, index) => (
                <div key={`${line.sku}-${index}`}>
                  {line.quantity}× {line.name}{' '}
                  <span className="text-bambu-gray-light">({t(`baseSync.mapping.${line.mapping}`)})</span>
                </div>
              ))}
            </div>
          )}
          {mutation.isError && (
            <p role="alert" className="text-sm text-red-400">
              {(mutation.error as Error).message}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3 border-t border-bambu-dark-tertiary shrink-0">
          <span className="text-sm text-bambu-gray-light mr-auto min-w-0">
            {summary
              ? t('baseSync.acceptModal.summary', { list: summary })
              : t('baseSync.acceptModal.summaryNothing')}
          </span>
          <Button type="button" variant="secondary" onClick={onClose} className="pointer-coarse:min-h-11!">
            {t('common.cancel')}
          </Button>
          <Button
            data-autofocus
            type="submit"
            disabled={mutation.isPending || !ready || wanted.size === 0}
            className="pointer-coarse:min-h-11!"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t(accepted ? 'common.save' : 'baseSync.acceptModal.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** A one-sentence hint; the longer explanation under an (i). */
function HintWithDetails({ short, details }: { short: string; details: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-bambu-gray">
      <div className="flex items-start gap-1">
        <span className="flex-1">{short}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={t('baseSync.acceptModal.more')}
          className="p-2 -m-1.5 text-bambu-gray hover:text-white"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
      {open && <p className="mt-1 text-bambu-gray-light">{details}</p>}
    </div>
  );
}

interface ProductChoiceCardProps {
  productId: number;
  name: string;
  wanted: number;
  choice: Choice;
  onChange: (patch: Partial<Choice>) => void;
}

function ProductChoiceCard({ productId, name, wanted, choice, onChange }: ProductChoiceCardProps) {
  const { t } = useTranslation();
  const { data: product, isLoading, isError, refetch } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.getProduct(productId),
  });
  const partKey = product?.parts.map((p) => p.id).join(',');
  useEffect(() => {
    if (product) onChange({ parts: product.parts.map((p) => p.id) });
    // Once the product's parts are known (or change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partKey]);
  const inStock = (partId: number) =>
    (product?.stock ?? []).filter((s) => s.part_id === partId && s.pieces > 0).reduce((sum, s) => sum + s.pieces, 0);

  return (
    <div className="rounded-lg border border-bambu-dark-tertiary p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-white font-medium flex-1 min-w-0 truncate">{name}</span>
        <span className="text-sm text-bambu-gray">{t('baseSync.acceptModal.toPrint', { wanted })}</span>
        <PieceStepper
          label={t('baseSync.acceptModal.toPrintLabel', { name })}
          max={wanted}
          value={choice.units}
          onChange={(units) =>
            onChange({
              units,
              // What is on hand never goes beyond what the products to print take.
              have: Object.fromEntries(
                Object.entries(choice.have).map(([partId, pieces]) => {
                  const part = product?.parts.find((p) => p.id === Number(partId));
                  return [partId, part ? Math.min(pieces, units * part.quantity) : pieces];
                }),
              ),
            })
          }
        />
      </div>
      {choice.units > 0 && isLoading && (
        <div className="mt-3 space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded bg-bambu-dark-tertiary/60 animate-pulse" />
          ))}
        </div>
      )}
      {choice.units > 0 && isError && (
        <div role="alert" className="mt-3 flex items-center gap-2 text-sm text-red-400">
          {t('baseSync.acceptModal.loadFailed')}
          <Button type="button" size="sm" variant="secondary" onClick={() => refetch()}>
            {t('products.qc.retry')}
          </Button>
        </div>
      )}
      {choice.units > 0 && product && (
        <table className="w-full mt-3 text-sm">
          <thead>
            <tr className="text-xs text-bambu-gray text-left">
              <th className="font-normal py-1">{t('baseSync.acceptModal.part')}</th>
              <th className="font-normal py-1 text-right pr-3">{t('baseSync.acceptModal.needed')}</th>
              <th className="font-normal py-1 text-right pr-3">{t('baseSync.acceptModal.inStock')}</th>
              <th className="font-normal py-1 text-right">{t('baseSync.acceptModal.have')}</th>
            </tr>
          </thead>
          <tbody>
            {product.parts.map((part) => {
              const needed = choice.units * part.quantity;
              return (
                <tr key={part.id} className="text-bambu-gray-light">
                  <td className="py-1">{part.name}</td>
                  <td className="py-1 text-right pr-3">{needed}</td>
                  <td className="py-1 text-right pr-3">{inStock(part.id)}</td>
                  <td className="py-1 text-right">
                    <PieceStepper
                      label={t('baseSync.acceptModal.haveLabel', { part: part.name, name })}
                      max={needed}
                      value={Math.min(choice.have[part.id] ?? 0, needed)}
                      onChange={(pieces) => onChange({ have: { ...choice.have, [part.id]: pieces } })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
