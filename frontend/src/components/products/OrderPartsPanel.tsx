import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageOff, Info, Loader2, PackageCheck } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderAcceptProduct, ProductDetail } from '../../api/client';
import { Button } from '../Button';
import { PieceStepper } from './PieceStepper';
import { useToast } from '../../contexts/ToastContext';
import { useUndoToast } from '../../hooks/useUndoToast';
import { sendLabel, wantedUnits } from '../../utils/baseOrders';

const TOUCH = 'pointer-coarse:min-h-11!';
// A change is saved this long after the last tap.
const SAVE_AFTER_MS = 400;
// What the operator already has: the opposite of printing, so never green.
const HAVE_TEXT = 'text-sky-700 dark:text-sky-300';
// Mirrors PieceStepper: above this a count is a − n + stepper, not segments.
const SEGMENTS_UP_TO = 4;

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
 * Fork (Base sync): an order's parts, opened under its row. Per product the
 * operator marks what is there already (whole products, loose parts); what is
 * left to print is only read. On a waiting order
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
      <div className="grid gap-3 xl:grid-cols-2 items-start">
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
      </div>
      {waiting && order.draft?.nothing_to_print && (
        <p role="status" className={`flex items-start gap-2 text-sm ${HAVE_TEXT}`}>
          <PackageCheck aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0" />
          {t('baseSync.parts.orderNothing')}
        </p>
      )}
      {canAct && (
        <div className="flex flex-wrap justify-end gap-2">
          {accepted && (
            <Button variant="ghost" className={`${TOUCH} text-red-500 mr-auto`} onClick={onWithdraw}>
              {t('baseSync.withdraw')}
            </Button>
          )}
          {waiting && (
            <Button className={TOUCH} onClick={onPrint} disabled={printing}>
              {printing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                order.draft?.nothing_to_print && <PackageCheck className="w-4 h-4" />
              )}
              {t(sendLabel(order))}
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

  const held = choice ? wanted - choice.units : 0;
  const rows = (product?.parts ?? []).map((part) => {
    const needed = (choice?.units ?? 0) * part.quantity;
    const have = Math.min(choice?.have[part.id] ?? 0, needed);
    return { part, needed, have, toPrint: needed - have };
  });
  const nothingLeft = choice != null && (choice.units === 0 || (rows.length > 0 && rows.every((r) => r.toPrint === 0)));
  const touched = choice != null && (held > 0 || Object.values(choice.have).some((n) => n > 0));
  const setHeld = (n: number) => {
    if (!choice) return;
    const units = wanted - n;
    // Fewer to make: loose pieces cannot exceed what those need.
    change({
      units,
      have: Object.fromEntries(
        Object.entries(choice.have).map(([partId, pieces]) => {
          const part = product?.parts.find((p) => p.id === Number(partId));
          return [partId, part ? Math.min(pieces, units * part.quantity) : pieces];
        }),
      ),
    });
  };

  return (
    <div className="rounded-lg bg-bambu-dark/60 p-3">
      <div className="flex items-center gap-3">
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy" className="w-12 h-12 rounded-lg object-cover bg-bambu-dark shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-bambu-dark flex items-center justify-center shrink-0">
            <ImageOff className="w-5 h-5 text-bambu-gray" />
          </div>
        )}
        <span className="text-white font-medium flex-1 min-w-0 break-words">{name}</span>
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
      {product && choice && (
        <div className="mt-3">
          {/* Column heads on wide screens; on a phone each row carries its own labels. */}
          <div className={`hidden sm:grid ${ROW_GRID} pb-1 text-[11px] font-semibold uppercase tracking-wide`}>
            <span />
            <span className={HAVE_TEXT}>{t('baseSync.parts.colHave')}</span>
            <span className="text-right text-bambu-green">{t('baseSync.parts.colPrint')}</span>
          </div>
          <PartsRow
            label={t('baseSync.parts.whole')}
            meta={t('baseSync.parts.ordered', { n: wanted })}
            strong
            toPrint={t('baseSync.parts.units', { n: choice.units })}
            toPrintLabel={t('baseSync.parts.productToPrint', { name, n: choice.units })}
            printing={choice.units > 0}
          >
            <PieceStepper
              label={t('baseSync.parts.wholeLabel', { name })}
              max={wanted}
              value={held}
              tone="shelf"
              disabled={!canAct}
              onChange={setHeld}
            />
            {canAct && wanted > SEGMENTS_UP_TO && <AllButton disabled={held >= wanted} onClick={() => setHeld(wanted)} />}
          </PartsRow>
          {choice.units > 0 && (
            <>
              <p className="border-t border-bambu-dark-tertiary pt-2 pb-1 text-xs text-bambu-gray">
                {t('baseSync.parts.partsCaption', { n: choice.units })}
              </p>
              {rows.map(({ part, needed, have, toPrint }) => {
                const ready = progress?.parts.find((p) => p.part_id === part.id);
                const busy = accepted ? printingOn(part.id) : undefined;
                const stock = inStock(part.id);
                const setHave = (pieces: number) => change({ ...choice, have: { ...choice.have, [part.id]: pieces } });
                return (
                  <PartsRow
                    key={part.id}
                    label={part.name}
                    meta={
                      <>
                        {t('baseSync.parts.needed', { needed })}
                        {stock > 0 && <> · {t('baseSync.parts.inStock', { stock })}</>}
                        {ready && (
                          <span className={ready.ready >= ready.needed ? ' text-bambu-green' : ' text-bambu-gray-light'}>
                            {' · '}
                            {t('baseSync.parts.ready', { ready: ready.ready, needed: ready.needed })}
                          </span>
                        )}
                      </>
                    }
                    warning={busy && have > 0 ? t('baseSync.parts.alreadyPrinting', { part: part.name, printer: busy }) : null}
                    toPrint={String(toPrint)}
                    toPrintLabel={t('baseSync.parts.partToPrint', { part: part.name, n: toPrint })}
                    printing={toPrint > 0}
                  >
                    <PieceStepper
                      label={t('baseSync.acceptModal.haveLabel', { part: part.name, name })}
                      max={needed}
                      value={have}
                      tone="shelf"
                      disabled={!canAct}
                      onChange={setHave}
                    />
                    {canAct && needed > SEGMENTS_UP_TO && <AllButton disabled={have >= needed} onClick={() => setHave(needed)} />}
                  </PartsRow>
                );
              })}
            </>
          )}
          {nothingLeft && (
            <p role="status" className={`mt-1 flex items-start gap-2 rounded-md bg-sky-500/10 px-3 py-2 text-sm ${HAVE_TEXT}`}>
              <PackageCheck aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0" />
              {t(choice.units === 0 ? 'baseSync.parts.haveWhole' : 'baseSync.parts.haveAllParts')}
            </p>
          )}
          {(save.isPending || saved || (canAct && touched)) && (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs">
              {save.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-bambu-gray" />
              ) : (
                saved && (
                  <span className="flex items-center gap-1 text-bambu-gray-light">
                    <Check className="w-3.5 h-3.5" />
                    {t('baseSync.parts.saved')}
                  </span>
                )
              )}
              {canAct && touched && (
                <button
                  type="button"
                  className="text-bambu-gray hover:text-white underline px-1 py-2 pointer-coarse:min-h-11"
                  onClick={() => change({ units: wanted, have: {} })}
                >
                  {t('baseSync.parts.clear')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// label | what I have (stepper) | what is left to print
const ROW_GRID = 'grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_15rem_6rem] gap-x-3';

interface PartsRowProps {
  label: string;
  meta: ReactNode;
  warning?: string | null;
  /** The whole-product row stands out from the part rows. */
  strong?: boolean;
  toPrint: string;
  /** Read out instead of the bare number. */
  toPrintLabel: string;
  printing: boolean;
  /** The "have" control. */
  children: ReactNode;
}

/**
 * One line of the table: on a phone the name and "to print" share the first
 * line and the control sits under them; wider, all three are side by side.
 */
function PartsRow({ label, meta, warning, strong, toPrint, toPrintLabel, printing, children }: PartsRowProps) {
  const { t } = useTranslation();
  return (
    <div className={`grid ${ROW_GRID} gap-y-1.5 items-center border-t border-bambu-dark-tertiary py-2`}>
      <div className="min-w-0 col-start-1 row-start-1">
        <span className={`text-sm text-white break-words ${strong ? 'font-semibold' : ''}`}>{label}</span>{' '}
        <span className="text-xs text-bambu-gray">{meta}</span>
        {warning && <span className="block text-xs text-amber-600 dark:text-amber-300">{warning}</span>}
      </div>
      <div className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1 flex items-center gap-2">
        <span className={`sm:hidden text-xs ${HAVE_TEXT}`}>{t('baseSync.parts.colHave')}</span>
        {children}
      </div>
      <div className="col-start-2 row-start-1 sm:col-start-3 text-right whitespace-nowrap">
        <span aria-hidden="true">
          <span className="sm:hidden text-xs text-bambu-gray">{t('baseSync.parts.colPrintInline')} </span>
          <span className={`text-base tabular-nums ${printing ? 'text-bambu-green font-semibold' : 'text-bambu-gray'}`}>
            {toPrint}
          </span>
        </span>
        <span className="sr-only">{toPrintLabel}</span>
      </div>
    </div>
  );
}

/** "I have all of them": one tap where the count is a − n + stepper. */
function AllButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-2 min-h-9 pointer-coarse:min-h-11 text-xs underline ${HAVE_TEXT} disabled:opacity-40 disabled:no-underline`}
    >
      {t('baseSync.parts.all')}
    </button>
  );
}
