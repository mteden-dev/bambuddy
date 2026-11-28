import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ImageOff, Info, Loader2, PackageCheck } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderAcceptProduct, ProductDetail } from '../../api/client';
import { Button } from '../Button';
import { PieceStepper } from './PieceStepper';
import { useToast } from '../../contexts/ToastContext';
import { useUndoToast } from '../../hooks/useUndoToast';
import { nothingToMake, sendLabel, wantedUnits } from '../../utils/baseOrders';
import { invalidatePlanQueries } from '../../utils/products';

const TOUCH = 'any-pointer-coarse:min-h-[44px]!';
// A draft's change is saved this long after the last tap.
const SAVE_AFTER_MS = 400;
// What the operator already has: the opposite of printing, so never green.
const HAVE_TEXT = 'text-sky-700 dark:text-sky-300';
// Mirrors PieceStepper: above this a count is a − n + stepper, not segments.
const SEGMENTS_UP_TO = 4;

interface Choice {
  units: number;
  have: Record<number, number>;
}

/** What the row's Print asks of an open panel: the choices on screen, unsaved ones too. */
export interface OrderPartsControls {
  /** Stops a pending save, waits for one under way and gives every product's choice (null: not all known). */
  flush: () => Promise<{ products: BaseOrderAcceptProduct[] } | null>;
}

interface ProductHandle {
  flush: () => Promise<BaseOrderAcceptProduct | null>;
}

interface OrderPartsPanelProps {
  order: BaseOrder;
  canAct: boolean;
  /** Send the order to production (a waiting one): the choices on screen are printed. */
  onPrint: () => void;
  printing: boolean;
  /** Take an accepted order out of production (asks first). */
  onWithdraw: () => void;
  /** Filled by the panel: the row's own Print sends what is on screen too. */
  controls?: MutableRefObject<OrderPartsControls | null>;
  /** A choice is being saved (Print waits for it). */
  onSavingChange?: (saving: boolean) => void;
}

function asNumbers(record: Record<string, number> | undefined | null): Record<number, number> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [Number(k), v]));
}

/**
 * Fork (Base sync): an order's parts, opened under its row. Per product the
 * operator marks what is there already (whole products, loose parts); what is
 * left to print is only read. On a waiting order this is saved by itself as a
 * draft (nothing goes to stock or the queue until it is sent); on one in
 * production each change replans, so it waits for "Apply", with "Undo".
 */
export function OrderPartsPanel({
  order,
  canAct,
  onPrint,
  printing,
  onWithdraw,
  controls,
  onSavingChange,
}: OrderPartsPanelProps) {
  const { t } = useTranslation();
  const [showInfo, setShowInfo] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<number>>(() => new Set());
  const handles = useRef(new Map<number, ProductHandle>());
  const accepted = order.state === 'accepted';
  const waiting = order.state === 'new' || order.state === 'skipped';
  const wanted = wantedUnits(order);
  const productIds = [...wanted.keys()];
  const nameOf = new Map(
    order.lines.filter((l) => l.product_id != null).map((l) => [l.product_id as number, l]),
  );
  const saving = savingIds.size > 0;

  const register = useCallback((productId: number, handle: ProductHandle | null) => {
    if (handle) handles.current.set(productId, handle);
    else handles.current.delete(productId);
  }, []);
  const onSaving = useCallback((productId: number, busy: boolean) => {
    setSavingIds((current) => {
      if (current.has(productId) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }, []);

  const idsKey = productIds.join(',');
  useEffect(() => {
    if (!controls) return;
    controls.current = {
      flush: async () => {
        const ids = idsKey ? idsKey.split(',').map(Number) : [];
        const products = await Promise.all(ids.map((id) => handles.current.get(id)?.flush() ?? Promise.resolve(null)));
        return products.every((p): p is BaseOrderAcceptProduct => p != null) ? { products } : null;
      },
    };
    return () => {
      controls.current = null;
    };
  }, [controls, idsKey]);

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);
  // Closed while saving: the row's Print does not wait for a panel that is gone.
  useEffect(() => () => onSavingChange?.(false), [onSavingChange]);

  return (
    <div className="mt-3 border-t border-bambu-dark-tertiary pt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-1 text-xs text-bambu-gray">
        <span className="flex-1 py-1">{t(waiting ? 'baseSync.parts.hintWaiting' : 'baseSync.partsHintAccepted')}</span>
        <button
          type="button"
          onClick={() => setShowInfo((v) => !v)}
          aria-expanded={showInfo}
          aria-label={t('baseSync.acceptModal.more')}
          className="p-2 -m-1.5 any-pointer-coarse:min-h-[44px] any-pointer-coarse:min-w-[44px] flex items-center justify-center text-bambu-gray hover:text-white"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
      {showInfo && <p className="text-xs text-bambu-gray-light">{t('baseSync.parts.info')}</p>}
      <div className="grid gap-3 xl:grid-cols-2 items-start">
        {productIds.map((productId) => (
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
            wanted={wanted.get(productId) ?? 0}
            canAct={canAct && (waiting || accepted)}
            register={register}
            onSaving={onSaving}
          />
        ))}
      </div>
      {waiting && nothingToMake(order) && (
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
            <Button className={TOUCH} onClick={onPrint} disabled={printing || saving}>
              {printing || saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                nothingToMake(order) && <PackageCheck className="w-4 h-4" />
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
  register: (productId: number, handle: ProductHandle | null) => void;
  onSaving: (productId: number, saving: boolean) => void;
}

/** The choice the server holds for one product: the draft of a waiting order, what an accepted one applies. */
function serverChoice(order: BaseOrder, productId: number, wanted: number, product: ProductDetail): Choice {
  const waiting = order.state !== 'accepted';
  const held = waiting ? asNumbers(order.draft?.held) : asNumbers(order.held);
  const onHand = waiting ? asNumbers(order.draft?.on_hand) : asNumbers(order.on_hand);
  const parts = new Set(product.parts.map((p) => p.id));
  return {
    units: Math.max(0, wanted - (held[productId] ?? 0)),
    have: Object.fromEntries(Object.entries(onHand).filter(([partId]) => parts.has(Number(partId)))),
  };
}

/** Comparable form of a choice: no zero counts, parts in order. */
function keyOf(c: Choice | null): string | null {
  if (!c) return null;
  const have = Object.entries(c.have)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => [Number(k), n])
    .sort((a, b) => a[0] - b[0]);
  return JSON.stringify([c.units, have]);
}

function ProductParts({ order, productId, name, thumbnail, wanted, canAct, register, onSaving }: ProductPartsProps) {
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The order changed in Base under a choice not saved yet.
  const [stale, setStale] = useState(false);

  const choiceRef = useRef<Choice | null>(null);
  choiceRef.current = choice;
  // The server's choice the one on screen started from, and the choices sent since (their echo is ours).
  const baseline = useRef<Choice | null>(null);
  const sent = useRef(new Set<string>());
  // One save at a time: a change made meanwhile waits here, only the latest.
  const inFlight = useRef<Promise<void> | null>(null);
  const queued = useRef<{ choice: Choice; undo: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const latest = useRef({ accepted, orderId: order.order_id });
  latest.current = { accepted, orderId: order.order_id };

  const server = product ? serverChoice(order, productId, wanted, product) : null;
  const serverKey = keyOf(server);

  const toBody = useCallback(
    (c: Choice): BaseOrderAcceptProduct => ({
      product_id: productId,
      units: c.units,
      have: Object.entries(c.have)
        .filter(([, pieces]) => pieces > 0)
        .map(([partId, pieces]) => ({ part_id: Number(partId), pieces })),
    }),
    [productId],
  );

  const start = (c: Choice, undo: boolean) => {
    const { accepted: applying, orderId } = latest.current;
    const before = baseline.current;
    sent.current.add(keyOf(c) as string);
    setSaving(true);
    const body = { products: [toBody(c)] };
    inFlight.current = (applying ? api.acceptBaseOrder(orderId, body) : api.saveBaseOrderDraft(orderId, body))
      .then(() => {
        setSaved(true);
        invalidatePlanQueries(queryClient);
        // Undo goes through the API: it works when the row has left the list or the panel is closed.
        if (applying && !undo && before) undoToast(t('baseSync.parts.changed'), () => undoTo(before));
      })
      .catch((e: Error) => {
        sent.current.delete(keyOf(c) as string);
        showToast(e.message, 'error');
      })
      .finally(() => {
        inFlight.current = null;
        const next = queued.current;
        queued.current = null;
        if (next) start(next.choice, next.undo);
        else setSaving(false);
      });
  };
  const enqueue = (c: Choice, undo = false) => {
    if (inFlight.current) queued.current = { choice: c, undo };
    else start(c, undo);
  };
  const cancelTimer = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const undoTo = (before: Choice) => {
    cancelTimer();
    setChoice(before);
    setStale(false);
    enqueue(before, true);
  };

  // Follows the server: a fresh choice when it changed and nothing here is unsaved;
  // a note instead of overwriting what the operator is changing.
  useEffect(() => {
    if (!server) return;
    const mine = keyOf(choiceRef.current);
    if (baseline.current === null) {
      baseline.current = server;
      setChoice(server);
      return;
    }
    if (serverKey === keyOf(baseline.current)) return;
    if (sent.current.has(serverKey as string) || serverKey === mine) {
      // Our own save came back.
      baseline.current = server;
      setStale(false);
      return;
    }
    const unsaved = mine !== keyOf(baseline.current) || timer.current != null || queued.current != null || inFlight.current != null;
    if (!unsaved) {
      baseline.current = server;
      sent.current.clear();
      setChoice(server);
      return;
    }
    setStale(true);
    // Only the server's answer matters here; `server` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const reload = () => {
    if (!server) return;
    cancelTimer();
    queued.current = null;
    baseline.current = server;
    sent.current.clear();
    setChoice(server);
    setStale(false);
  };

  useEffect(() => {
    onSaving(productId, saving);
  }, [productId, saving, onSaving]);

  useEffect(() => {
    register(productId, {
      flush: async () => {
        // Print sends the choice itself: a draft save not yet sent is dropped, one under way is waited for.
        cancelTimer();
        queued.current = null;
        while (inFlight.current) await inFlight.current;
        const c = choiceRef.current;
        if (!c) return null;
        sent.current.add(keyOf(c) as string);
        return toBody(c);
      },
    });
    return () => register(productId, null);
  }, [productId, register, toBody]);

  useEffect(() => () => cancelTimer(), []);

  const change = (next: Choice) => {
    setChoice(next);
    setSaved(false);
    if (accepted) return; // applied with "Apply": each change replans
    cancelTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      enqueue(next);
    }, SAVE_AFTER_MS);
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
  // An order in production: a change not applied yet.
  const unapplied = accepted && choice != null && keyOf(choice) !== keyOf(baseline.current);
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
      {stale && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" className="w-4 h-4 shrink-0" />
          <span className="flex-1 min-w-0">{t('baseSync.partsBaseChanged')}</span>
          <Button size="sm" variant="secondary" className={TOUCH} onClick={reload}>
            {t('baseSync.partsReload')}
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
          {(saving || saved || unapplied || (canAct && touched)) && (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs">
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-bambu-gray" />
              ) : (
                saved &&
                !unapplied && (
                  <span className="flex items-center gap-1 text-bambu-gray-light">
                    <Check className="w-3.5 h-3.5" />
                    {t('baseSync.parts.saved')}
                  </span>
                )
              )}
              {canAct && touched && (
                <button
                  type="button"
                  className="text-bambu-gray hover:text-white underline px-1 py-2 any-pointer-coarse:min-h-[44px]"
                  onClick={() => change({ units: wanted, have: {} })}
                >
                  {t('baseSync.parts.clear')}
                </button>
              )}
              {canAct && unapplied && (
                <Button size="sm" className={TOUCH} disabled={saving} onClick={() => choice && enqueue(choice)}>
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('baseSync.partsApply')}
                </Button>
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
      className={`px-2 min-h-9 any-pointer-coarse:min-h-[44px] text-xs underline ${HAVE_TEXT} disabled:opacity-40 disabled:no-underline`}
    >
      {t('baseSync.parts.all')}
    </button>
  );
}
