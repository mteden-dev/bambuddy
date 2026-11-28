import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ImageOff,
  Layers,
  Loader2,
  PackageCheck,
  RotateCcw,
  ShoppingBag,
} from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderAcceptProduct, BaseOrderLine } from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDateOnly, formatDateTime, formatRelativeTime } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import {
  isLate,
  missingParts,
  nothingToMake,
  openLines,
  ORDER_GRID,
  orderLate,
  sendLabel,
  shipKind,
  shortWhen,
  wantedUnits,
} from '../../utils/baseOrders';
import { OrderPartsPanel } from './OrderPartsPanel';
import type { OrderPartsControls } from './OrderPartsPanel';

const TOUCH = 'any-pointer-coarse:min-h-[44px]!';

interface OrderRowProps {
  order: BaseOrder;
  expanded: boolean;
  onToggle: () => void;
  canAct: boolean;
  /** Show the order's state (in "All" and in search results). */
  showState: boolean;
  /** part id -> name, for "I have: Base 1" on a waiting order. */
  partNames: Map<number, string>;
  busy: boolean;
  /** body: the choices of an open parts panel (unsaved ones too); none prints the saved draft. */
  onPrint: (body?: { products: BaseOrderAcceptProduct[] }) => void;
  onSkip: () => void;
  onRestore: () => void;
  onWithdraw: () => void;
  /** Plan an order in production again, for the pieces it misses (its print left the queue). */
  onRequeue: () => void;
  /** Open the plates the plan prints for an order in production (a preferred printer per plate). */
  onPlates: () => void;
  /** Say someone has a line already ("I have it": made by hand, no product yet), or take it back. */
  onHave: (line: BaseOrderLine, have: boolean) => void;
}

/** Allegro: an orange "A"; a shop: a bag. The account name says which Allegro account. */
function SourceMark({ order }: { order: BaseOrder }) {
  const { t } = useTranslation();
  return order.source_kind === 'allegro' ? (
    <span
      className="w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold text-white shrink-0"
      style={{ backgroundColor: '#FF5A00' }}
      title={order.source_name ?? 'Allegro'}
      aria-label="Allegro"
    >
      A
    </span>
  ) : (
    <span
      className="w-5 h-5 rounded flex items-center justify-center bg-sky-500/20 text-sky-600 dark:text-sky-300 shrink-0"
      title={order.source_name ?? t('baseSync.sourceShop')}
      aria-label={t('baseSync.sourceShop')}
    >
      <ShoppingBag className="w-3.5 h-3.5" />
    </span>
  );
}

/** When it ships (Allegro) or how old it is (a shop): what puts it where it is in the list. */
function WhenCell({ order }: { order: BaseOrder }) {
  const { t } = useTranslation();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  if (order.source_kind !== 'allegro' || !order.ship_by) {
    return (
      <span className="text-xs text-bambu-gray-light" title={formatDateTime(order.date_confirmed, timeFormat)}>
        {order.date_confirmed ? formatRelativeTime(order.date_confirmed, timeFormat, t) : '–'}
      </span>
    );
  }
  const kind = shipKind(order.ship_by);
  const date = formatDateOnly(order.ship_by, { weekday: 'short', day: 'numeric', month: 'short' });
  const done = order.ready || order.state === 'cancelled' || !!order.packed;
  const style: Record<string, string> = {
    late: 'bg-red-500/20 text-red-600 dark:text-red-300',
    today: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
    tomorrow: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-200',
    dayAfter: 'bg-bambu-dark-tertiary text-bambu-gray-light',
  };
  return (
    <span className="flex flex-col items-start gap-0.5">
      {kind && kind !== 'later' && !done ? (
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${style[kind]}`}>
          {t(`baseSync.ship.${kind}`)}
        </span>
      ) : (
        <span className="text-xs text-bambu-gray-light whitespace-nowrap">{date}</span>
      )}
      {kind && kind !== 'later' && !done && (
        <span className="hidden xl:block text-[11px] text-bambu-gray whitespace-nowrap">{date}</span>
      )}
    </span>
  );
}

function LineThumb({ line }: { line: BaseOrderLine }) {
  const [broken, setBroken] = useState(false);
  const size = 'w-12 h-12 xl:w-10 xl:h-10';
  if (line.mapping === 'product' && line.product_id != null && line.has_thumbnail && !broken) {
    return (
      <img
        src={api.getProductThumbnailUrl(line.product_id, line.thumbnail_version)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={`${size} rounded-lg object-cover bg-bambu-dark shrink-0`}
      />
    );
  }
  return (
    <div
      className={`${size} rounded-lg bg-bambu-dark flex items-center justify-center shrink-0 ${
        line.mapping === 'unmapped' && !line.have ? 'ring-1 ring-amber-500/60' : ''
      }`}
    >
      <ImageOff className="w-4 h-4 text-bambu-gray" />
    </div>
  );
}

/**
 * "I have it" on a line no product is mapped to (made by hand, not sliced yet), and on one marked so:
 * pressed, nothing is printed for it and it no longer keeps the order from ready.
 */
function HaveToggle({
  line,
  canMark,
  busy,
  onHave,
}: {
  line: BaseOrderLine;
  canMark: boolean;
  busy: boolean;
  onHave: (line: BaseOrderLine, have: boolean) => void;
}) {
  const { t } = useTranslation();
  const have = !!line.have;
  if (!canMark) {
    return have ? (
      <span className="inline-flex items-center gap-1 text-xs text-sky-700 dark:text-sky-300 shrink-0">
        <Check className="w-3.5 h-3.5" />
        {t('baseSync.heldAll')}
      </span>
    ) : null;
  }
  return (
    <button
      type="button"
      aria-pressed={have}
      disabled={busy}
      title={t(have ? 'baseSync.haveUndoTitle' : 'baseSync.haveTitle')}
      onClick={() => onHave(line, !have)}
      className={`shrink-0 inline-flex items-center justify-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 any-pointer-coarse:min-h-[44px] any-pointer-coarse:min-w-[64px] ${
        have
          ? 'border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300'
          : 'border-bambu-dark-tertiary text-bambu-gray-light hover:border-bambu-gray hover:text-white'
      }`}
    >
      {have && <Check className="w-3.5 h-3.5" />}
      {t('baseSync.have')}
    </button>
  );
}

function Line({
  order,
  line,
  index,
  canMark,
  busy,
  onHave,
}: {
  order: BaseOrder;
  line: BaseOrderLine;
  index: number;
  canMark: boolean;
  busy: boolean;
  onHave: (line: BaseOrderLine, have: boolean) => void;
}) {
  const { t } = useTranslation();
  const held = line.product_id != null ? (order.held?.[String(line.product_id)] ?? 0) : 0;
  const total = line.product_id != null ? (wantedUnits(order).get(line.product_id) ?? 0) : 0;
  // Held back per product: said once, on its first line.
  const firstOfProduct = order.lines.findIndex((other) => other.product_id === line.product_id) === index;
  return (
    <li className="flex items-center gap-2.5 min-h-[56px] xl:min-h-[44px]">
      <LineThumb line={line} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-white text-base font-semibold">{line.quantity}×</span>
          <span className="text-white text-sm truncate" title={line.name}>
            {line.mapping === 'product' ? line.product_name : line.name}
          </span>
          {line.units > 1 && (
            <span className="text-xs text-bambu-gray">{t('baseSync.inSet', { n: line.units })}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          <span className="text-bambu-gray">{line.sku}</span>
          {line.mapping === 'unmapped' && (
            <span
              className={`px-1.5 rounded ${
                line.have ? 'bg-bambu-dark-tertiary text-bambu-gray' : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
              }`}
            >
              {t('baseSync.mapping.unmapped')}
            </span>
          )}
          {line.mapping === 'not_printed' && (
            <span className="px-1.5 rounded bg-bambu-dark-tertiary text-bambu-gray">{t('baseSync.mapping.not_printed')}</span>
          )}
          {held > 0 && firstOfProduct && !line.have && (
            // All of it on hand is nothing to warn about; printing only some is.
            <span className={held >= total ? 'text-sky-700 dark:text-sky-300' : 'text-amber-600 dark:text-amber-300'}>
              {held >= total ? t('baseSync.heldAll') : t('baseSync.heldBack', { print: total - held, total })}
            </span>
          )}
        </div>
      </div>
      {(line.mapping === 'unmapped' || line.have) && (
        <HaveToggle line={line} canMark={canMark} busy={busy} onHave={onHave} />
      )}
    </li>
  );
}

/** In production: each product's parts there of the ones needed; waiting with a draft: what is on hand. */
function ProgressCell({ order, partNames }: { order: BaseOrder; partNames: Map<number, string> }) {
  const { t } = useTranslation();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  const missing = missingParts(order);
  // In production, lines no product is mapped to keep it from ready until someone has them.
  const open = order.state === 'accepted' ? openLines(order) : [];
  const openHint = open.length > 0 && (
    <div role="status" className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-300">
      <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>{t('baseSync.openLines', { list: open.map((line) => `${line.quantity}× ${line.name}`).join(', ') })}</span>
    </div>
  );
  if (order.packed) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded bg-bambu-dark-tertiary text-bambu-gray-light"
        title={t('baseSync.packedHint')}
      >
        <PackageCheck className="w-3.5 h-3.5" />
        {t('baseSync.packed')}
      </span>
    );
  }
  if (order.ready) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded bg-bambu-green/15 text-bambu-green">
        <PackageCheck className="w-3.5 h-3.5" />
        {t('baseSync.readyBadge')}
      </span>
    );
  }
  if (order.state === 'accepted' && order.progress.length) {
    return (
      <div className="space-y-1">
        {order.progress.map((product) => (
          <div key={product.product_order_id} className="text-xs text-bambu-gray-light leading-relaxed">
            {product.parts.map((part, i) => (
              <span key={part.part_id} className={part.ready >= part.needed ? 'text-bambu-green' : undefined}>
                {i > 0 && <span className="text-bambu-gray"> · </span>}
                {part.name} {part.ready}/{part.needed}
                {part.ready >= part.needed && <Check className="inline w-3 h-3 ml-0.5" />}
                {part.on_hand > 0 && (
                  <span className="text-bambu-gray"> {t('baseSync.fromShelfCount', { n: part.on_hand })}</span>
                )}
              </span>
            ))}
            {product.estimated_ready_at ? (
              <span className="text-bambu-gray">
                {' · '}
                {t('baseSync.readyAround', { time: shortWhen(product.estimated_ready_at, timeFormat) })}
                {isLate(product.estimated_ready_at, order.ship_by) && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded font-medium bg-red-500/20 text-red-600 dark:text-red-300">
                    {t('products.late')}
                  </span>
                )}
              </span>
            ) : (
              product.no_estimate_reason &&
              product.units_ready < product.units && (
                <span className="block text-bambu-gray">{t(`products.noEtaReason.${product.no_estimate_reason}`)}</span>
              )
            )}
          </div>
        ))}
        {missing.length > 0 && (
          <div role="status" className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-300">
            <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {t('baseSync.missing', { parts: missing.map((m) => `${m.name} ×${m.pieces}`).join(', ') })}
            </span>
          </div>
        )}
        {openHint}
      </div>
    );
  }
  if (openHint) return openHint;
  if (order.state !== 'accepted' && nothingToMake(order)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-sky-700 dark:text-sky-300">
        <PackageCheck className="w-3.5 h-3.5 shrink-0" />
        {t('baseSync.haveAll')}
      </span>
    );
  }
  if (order.draft) {
    // Whole products first ("1× Box"), then loose parts ("Base 1").
    const productName = (id: number) => {
      const line = order.lines.find((l) => l.product_id === id);
      return line?.product_name ?? line?.name ?? `#${id}`;
    };
    const have = [
      ...Object.entries(order.draft.held)
        .filter(([, n]) => n > 0)
        .map(([productId, n]) => `${n}× ${productName(Number(productId))}`),
      ...Object.entries(order.draft.on_hand).map(
        ([partId, n]) => `${partNames.get(Number(partId)) ?? `#${partId}`} ${n}`,
      ),
    ];
    if (have.length) {
      return <span className="text-xs text-sky-700 dark:text-sky-300">{t('baseSync.haveDraft', { list: have.join(', ') })}</span>;
    }
  }
  return null;
}

/**
 * Fork (Base sync): one order in the list. On a Mac a table row (when, order,
 * lines, progress, actions); on an iPad a card in three bands. A tap on the
 * row opens its parts underneath.
 */
export function OrderRow(props: OrderRowProps) {
  const {
    order,
    expanded,
    onToggle,
    canAct,
    showState,
    partNames,
    busy,
    onPrint,
    onSkip,
    onRestore,
    onWithdraw,
    onRequeue,
    onPlates,
    onHave,
  } = props;
  const { t } = useTranslation();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  const [allLines, setAllLines] = useState(false);
  // An open parts panel: Print sends its choices, and waits while one is being saved.
  const parts = useRef<OrderPartsControls | null>(null);
  const [partsSaving, setPartsSaving] = useState(false);
  const print = async () => {
    const body = expanded && parts.current ? await parts.current.flush() : null;
    onPrint(body ?? undefined);
  };
  // Products to print: a line someone has already prints nothing.
  const hasProducts = order.lines.some((line) => line.mapping === 'product' && !line.have);
  const waiting = order.state === 'new' || order.state === 'skipped';
  // Packed in Base: done, listed with the ready ones; nothing to do on it any more.
  const packedState = !!order.packed && (order.state === 'new' || order.state === 'accepted');
  const act = canAct && !order.packed;
  const canMark = act && order.state !== 'cancelled';
  const missing = missingParts(order).length > 0;
  // Three lines; the rest behind "+N" (all of them once the row is open).
  const shownLines = allLines || expanded ? order.lines : order.lines.slice(0, 3);
  const hiddenLines = order.lines.length - shownLines.length;

  return (
    <Card
      id={`order-${order.order_id}`}
      className={`p-3 ${order.packed ? 'opacity-60' : ''} ${
        expanded ? 'ring-1 ring-bambu-green/40' : ''
      }`}
    >
      <div
        className={`grid gap-3 ${ORDER_GRID} xl:items-start cursor-pointer`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a, input, select')) return;
          if (hasProducts) onToggle();
        }}
      >
        <div className="flex items-center gap-2.5 xl:contents">
          <div className="xl:pt-0.5">
            <WhenCell order={order} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <SourceMark order={order} />
              <span
                className="text-white font-semibold text-base truncate"
                title={`Base ${order.order_id}${order.number ? ` · #${order.number}` : ''}`}
              >
                {order.label}
              </span>
              {orderLate(order) && (
                <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-600 dark:text-red-300 shrink-0">
                  {t('products.late')}
                </span>
              )}
              {showState && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-dark-tertiary text-bambu-gray-light shrink-0">
                  {t(
                    packedState
                      ? 'baseSync.state.packed'
                      : order.ready
                        ? 'baseSync.state.ready'
                        : `baseSync.state.${order.state}`,
                  )}
                </span>
              )}
            </div>
            <div className="text-xs text-bambu-gray truncate mt-0.5">
              {[order.source_name, order.date_confirmed ? formatDateTime(order.date_confirmed, timeFormat) : null]
                .filter(Boolean)
                .join(' · ')}
              <span className="hidden xl:inline"> · Base {order.order_id}</span>
            </div>
          </div>
          <span className="xl:hidden ml-auto text-xs text-bambu-gray shrink-0">Base {order.order_id}</span>
        </div>

        <div className="min-w-0">
          <ul className="space-y-1">
            {shownLines.map((line, index) => (
              <Line
                key={`${line.sku}-${index}`}
                order={order}
                line={line}
                index={index}
                canMark={canMark}
                busy={busy}
                onHave={onHave}
              />
            ))}
          </ul>
          {hiddenLines > 0 && (
            <button
              type="button"
              className="text-xs text-bambu-green hover:underline py-2 any-pointer-coarse:min-h-[44px]"
              onClick={() => setAllLines(true)}
            >
              {t('baseSync.moreLines', { n: hiddenLines })}
            </button>
          )}
        </div>

        <div className="min-w-0 xl:pt-1">
          <ProgressCell order={order} partNames={partNames} />
        </div>

        {act && (
          <div className="flex flex-wrap justify-end gap-2">
            {order.state === 'new' && (
              <Button size="sm" variant="ghost" className={TOUCH} onClick={onSkip} disabled={busy}>
                {t('baseSync.skip')}
              </Button>
            )}
            {order.state === 'skipped' && (
              <Button size="sm" variant="ghost" className={TOUCH} onClick={onRestore} disabled={busy}>
                {t('baseSync.restore')}
              </Button>
            )}
            {hasProducts && (waiting || order.state === 'accepted') && (
              <Button
                size="sm"
                variant="secondary"
                className={TOUCH}
                aria-expanded={expanded}
                onClick={onToggle}
              >
                {t('baseSync.partsButton')}
                <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </Button>
            )}
            {hasProducts && order.state === 'accepted' && !order.ready && (
              <Button size="sm" variant="secondary" className={TOUCH} onClick={onPlates}>
                <Layers className="w-4 h-4" />
                {t('baseSync.plates.button')}
              </Button>
            )}
            {missing && (
              <Button size="sm" className={TOUCH} onClick={onRequeue} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                {t('baseSync.requeue')}
              </Button>
            )}
            {waiting && (
              <Button size="sm" className={TOUCH} onClick={print} disabled={busy || partsSaving}>
                {busy || partsSaving ? (
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
      {expanded && hasProducts && (
        <OrderPartsPanel
          order={order}
          canAct={act}
          onPrint={print}
          printing={busy}
          onWithdraw={onWithdraw}
          controls={parts}
          onSavingChange={setPartsSaving}
        />

      )}
    </Card>
  );
}
