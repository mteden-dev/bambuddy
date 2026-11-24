import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageOff, Info, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderAcceptProduct, ProductDetail } from '../../api/client';
import { Button } from '../Button';
import { PieceStepper } from './PieceStepper';
import { useToast } from '../../contexts/ToastContext';
import { useUndoToast } from '../../hooks/useUndoToast';
import { wantedUnits } from '../../utils/baseOrders';

const TOUCH = 'pointer-coarse:min-h-11!';
// A change is saved this long after the last tap.
const SAVE_AFTER_MS = 400;

interface Choice {
  units: number;
  have: Record<number, number>;
}

interface OrderPartsPanelProps {
  order: BaseOrder;
  canAct: boolean;
  /** Send the order to production (a waiting one): its saved choice is printed. */
  onPrint: () => void;
  printing: boolean;
  /** Take an accepted order out of production (asks first). */
  onWithdraw: () => void;
}

function asNumbers(record: Record<string, number> | undefined | null): Record<number, number> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [Number(k), v]));
}

/**
 * Fork (Base sync): an order's parts, opened under its row. Per product: how
 * many to print and which parts are on the shelf already. On a waiting order
 * this is saved at once as a draft (nothing goes to stock or the queue until
 * it is sent); on one in production it is applied at once and replans, with
 * "Undo".
 */
export function OrderPartsPanel({ order, canAct, onPrint, printing, onWithdraw }: OrderPartsPanelProps) {
  const { t } = useTranslation();
  const [showInfo, setShowInfo] = useState(false);
  const accepted = order.state === 'accepted';
  const waiting = order.state === 'new' || order.state === 'skipped';
  const wanted = wantedUnits(order);
  const nameOf = new Map(
    order.lines.filter((l) => l.product_id != null).map((l) => [l.product_id as number, l]),
  );

  return (
    <div className="mt-3 border-t border-bambu-dark-tertiary pt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-1 text-xs text-bambu-gray">
        <span className="flex-1">{t(waiting ? 'baseSync.parts.hintWaiting' : 'baseSync.parts.hintAccepted')}</span>
        <button
          type="button"
          onClick={() => setShowInfo((v) => !v)}
          aria-expanded={showInfo}
          aria-label={t('baseSync.acceptModal.more')}
          className="p-2 -m-1.5 text-bambu-gray hover:text-white"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
      {showInfo && <p className="text-xs text-bambu-gray-light">{t('baseSync.parts.info')}</p>}
      {[...wanted].map(([productId, units]) => (
        <ProductParts
          key={productId}
          order={order}
          productId={productId}
          name={nameOf.get(productId)?.product_name ?? nameOf.get(productId)?.name ?? `#${productId}`}
          thumbnail={
            nameOf.get(productId)?.has_thumbnail
              ? api.getProductThumbnailUrl(productId, nameOf.get(productId)?.thumbnail_version ?? null)
              : null
          }
          wanted={units}
          canAct={canAct && (waiting || accepted)}
        />
      ))}
      {canAct && (
        <div className="flex flex-wrap justify-end gap-2">
          {accepted && (
            <Button variant="ghost" className={`${TOUCH} text-red-500 mr-auto`} onClick={onWithdraw}>
              {t('baseSync.withdraw')}
            </Button>
          )}
          {waiting && (
            <Button className={TOUCH} onClick={onPrint} disabled={printing}>
              {printing && <Loader2 className="w-4 h-4 animate-spin" />}
              {t(order.draft ? 'baseSync.printRest' : 'baseSync.print')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface ProductPartsProps {
  order: BaseOrder;
  productId: number;
  name: string;
  thumbnail: string | null;
  wanted: number;
  canAct: boolean;
}

function initialChoice(order: BaseOrder, productId: number, wanted: number, product: ProductDetail | undefined): Choice {
  const waiting = order.state !== 'accepted';
  const held = waiting ? asNumbers(order.draft?.held) : asNumbers(order.held);
  const onHand = waiting ? asNumbers(order.draft?.on_hand) : asNumbers(order.on_hand);
  const parts = new Set((product?.parts ?? []).map((p) => p.id));
  return {
    units: Math.max(0, wanted - (held[productId] ?? 0)),
    have: Object.fromEntries(Object.entries(onHand).filter(([partId]) => parts.has(Number(partId)))),
  };
}

function ProductParts({ order, productId, name, thumbnail, wanted, canAct }: ProductPartsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const undoToast = useUndoToast();
  const accepted = order.state === 'accepted';
  const { data: product, isLoading, isError, refetch } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.getProduct(productId),
  });
  const [choice, setChoice] = useState<Choice | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = useRef(false);
  const lastSaved = useRef<Choice | null>(null);

  useEffect(() => {
    if (product && choice === null) {
      const start = initialChoice(order, productId, wanted, product);
      setChoice(start);
      lastSaved.current = start;
    }
  }, [product, choice, order, productId, wanted]);

  const toBody = (c: Choice): { products: BaseOrderAcceptProduct[] } => ({
    products: [
      {
        product_id: productId,
        units: c.units,
        have: Object.entries(c.have)
          .filter(([, pieces]) => pieces > 0)
          .map(([partId, pieces]) => ({ part_id: Number(partId), pieces })),
      },
    ],
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['base-sync'] });
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['product'] });
    queryClient.invalidateQueries({ queryKey: ['queue'] });
  };
  const save = useMutation({
    mutationFn: (c: Choice) =>
      accepted ? api.acceptBaseOrder(order.order_id, toBody(c)) : api.saveBaseOrderDraft(order.order_id, toBody(c)),
    onSuccess: (_, c) => {
      const before = lastSaved.current;
      lastSaved.current = c;
      setSaved(true);
      refresh();
      if (accepted && before) {
        undoToast(t('baseSync.parts.changed'), () => {
          setChoice(before);
          dirty.current = true;
        });
      }
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  useEffect(() => {
    if (!choice || !dirty.current) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      dirty.current = false;
      save.mutate(choice);
    }, SAVE_AFTER_MS);
    return () => window.clearTimeout(timer);
    // Saved after the taps stop; the mutation object is stable enough for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);

  const change = (next: Choice) => {
    dirty.current = true;
    setChoice(next);
  };
  const inStock = (partId: number) =>
    (product?.stock ?? []).filter((s) => s.part_id === partId && s.pieces > 0).reduce((sum, s) => sum + s.pieces, 0);
  const progress = order.progress.find((p) => p.product_id === productId);
  const printingOn = (partId: number) =>
    (product?.jobs ?? []).find((j) => j.status === 'printing' && j.pieces.some((p) => p.part_id === partId))
      ?.printer_name;

  const summary = choice && product
    ? (() => {
        const toMake: string[] = [];
        const fromShelf: string[] = [];
        for (const part of product.parts) {
          const needed = choice.units * part.quantity;
          const have = Math.min(choice.have[part.id] ?? 0, needed);
          if (needed - have > 0) toMake.push(`${part.name} ${needed - have}`);
          if (have > 0) fromShelf.push(`${part.name} ${have}`);
        }
        return { toMake, fromShelf };
      })()
    : null;

  return (
    <div className="rounded-lg bg-bambu-dark/60 p-3">
      <div className="flex flex-wrap items-center gap-3">
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy" className="w-16 h-16 rounded-lg object-cover bg-bambu-dark shrink-0" />
        ) : (
          <div className="w-16 h-16 rounded-lg bg-bambu-dark flex items-center justify-center shrink-0">
            <ImageOff className="w-5 h-5 text-bambu-gray" />
          </div>
        )}
        <span className="text-white font-medium flex-1 min-w-[8rem]">{name}</span>
        {choice && (
          <span className="flex items-center gap-2 text-sm text-bambu-gray">
            {t('baseSync.parts.toPrint')}
            <PieceStepper
              label={t('baseSync.acceptModal.toPrintLabel', { name })}
              max={wanted}
              value={choice.units}
              disabled={!canAct}
              onChange={(units) =>
                change({
                  units,
                  have: Object.fromEntries(
                    Object.entries(choice.have).map(([partId, pieces]) => {
                      const part = product?.parts.find((p) => p.id === Number(partId));
                      return [partId, part ? Math.min(pieces, units * part.quantity) : pieces];
                    }),
                  ),
                })
              }
            />
            {t('baseSync.parts.ofWanted', { wanted })}
          </span>
        )}
      </div>
      {isLoading && (
        <div className="mt-3 space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-11 rounded bg-bambu-dark-tertiary/60 animate-pulse" />
          ))}
        </div>
      )}
      {isError && (
        <div role="alert" className="mt-3 flex items-center gap-2 text-sm text-red-400">
          {t('baseSync.acceptModal.loadFailed')}
          <Button size="sm" variant="secondary" className={TOUCH} onClick={() => refetch()}>
            {t('products.qc.retry')}
          </Button>
        </div>
      )}
      {product && choice && choice.units > 0 && (
        <ul className="mt-3 space-y-1">
          {product.parts.map((part) => {
            const needed = choice.units * part.quantity;
            const ready = progress?.parts.find((p) => p.part_id === part.id);
            const busy = accepted ? printingOn(part.id) : undefined;
            return (
              <li key={part.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-[44px] pointer-coarse:min-h-[52px]">
                <span className="text-sm text-white w-20 shrink-0">{part.name}</span>
                <span className="text-xs text-bambu-gray flex-1 min-w-[10rem]">
                  {t('baseSync.parts.neededInStock', { needed, stock: inStock(part.id) })}
                  {ready && (
                    <span className={ready.ready >= ready.needed ? ' text-bambu-green' : ' text-bambu-gray-light'}>
                      {' · '}
                      {t('baseSync.parts.ready', { ready: ready.ready, needed: ready.needed })}
                    </span>
                  )}
                  {busy && (choice.have[part.id] ?? 0) > 0 && (
                    <span className="block text-amber-600 dark:text-amber-300">
                      {t('baseSync.parts.alreadyPrinting', { part: part.name, printer: busy })}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2 text-xs text-bambu-gray">
                  {t('baseSync.parts.fromShelf')}
                  <PieceStepper
                    label={t('baseSync.acceptModal.haveLabel', { part: part.name, name })}
                    max={needed}
                    value={Math.min(choice.have[part.id] ?? 0, needed)}
                    disabled={!canAct}
                    onChange={(pieces) => change({ ...choice, have: { ...choice.have, [part.id]: pieces } })}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {summary && choice && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-bambu-gray-light flex-1 min-w-0">
            {choice.units === 0
              ? t('baseSync.parts.nothing')
              : [
                  summary.toMake.length ? t('baseSync.parts.willPrint', { list: summary.toMake.join(', ') }) : t('baseSync.parts.nothingToPrint'),
                  summary.fromShelf.length ? t('baseSync.parts.shelfList', { list: summary.fromShelf.join(', ') }) : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
          </span>
          {save.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-bambu-gray" />
          ) : (
            saved && (
              <span className="flex items-center gap-1 text-bambu-green">
                <Check className="w-3.5 h-3.5" />
                {t('baseSync.parts.saved')}
              </span>
            )
          )}
          {canAct && Object.values(choice.have).some((n) => n > 0) && (
            <button
              type="button"
              className="text-bambu-gray hover:text-white underline px-1 py-2"
              onClick={() => change({ units: wanted, have: {} })}
            >
              {t('baseSync.parts.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
