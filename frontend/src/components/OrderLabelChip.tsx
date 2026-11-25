import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { ProductJobOrders, ProductOrderTag } from '../api/client';
import { useJobOrders } from '../hooks/useJobOrders';
import { formatDateOnly } from '../utils/date';
import { jobOrdersText, shipKind, urgentFirst } from '../utils/baseOrders';

interface OrderLabelChipProps {
  /** A queue job's orders. */
  itemId?: number;
  /** What a printer prints now. */
  printerId?: number;
  /** "list": every order on its own line (job details); "chip" (default): the most urgent "+N". */
  variant?: 'chip' | 'list';
}

const DOT: Record<string, string> = { allegro: 'bg-[#FF5A00]', shop: 'bg-sky-400' };

/** Opens an order on the Orders page, through the router's history (no router needed here). */
function openOrder(baseOrderId: number) {
  window.history.pushState({}, '', `/orders?order=${baseOrderId}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function urgency(tag: ProductOrderTag | undefined): string {
  const kind = shipKind(tag?.ship_by ?? tag?.due ?? null);
  return kind === 'late' ? 'text-red-400' : kind === 'today' ? 'text-amber-300' : 'text-white';
}

function useEntry(itemId?: number, printerId?: number): ProductJobOrders | undefined {
  const { data } = useJobOrders();
  if (itemId != null) return data?.items[String(itemId)];
  if (printerId != null) return data?.printers[String(printerId)];
  return undefined;
}

/** The order lines a hover or the popup shows: label, Base id and source, ship-by date. */
function useLines(entry: ProductJobOrders | undefined) {
  const { t } = useTranslation();
  return urgentFirst(entry).map((tag) => {
    const when = tag.ship_by ? formatDateOnly(tag.ship_by, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
    return { tag, text: [tag.label, tag.title, when ? t('baseSync.shipBy', { date: when }) : null].filter(Boolean).join(' · ') };
  });
}

/**
 * Fork (products): which order a print is for, next to the job in the queue,
 * its timeline details and on the printer card: an Allegro nick or a shop's
 * number, "+N" for more orders on one plate, "for stock" for none. The Base
 * order id shows on hover; a click (a tap on an iPad) lists them, each a link
 * to its order.
 */
export function OrderLabelChip({ itemId, printerId, variant = 'chip' }: OrderLabelChipProps) {
  const { t } = useTranslation();
  const entry = useEntry(itemId, printerId);
  const lines = useLines(entry);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [open]);

  const text = jobOrdersText(entry, t('products.orderLabel.forStock'));
  if (!entry || !text) return null;
  const main = lines[0]?.tag;
  const goTo = (tag: ProductOrderTag) => {
    if (tag.base_order_id != null) openOrder(tag.base_order_id);
  };

  if (variant === 'list') {
    if (!lines.length) return <div className="text-xs text-bambu-gray">{text}</div>;
    return (
      <div className="text-xs">
        <div className="text-bambu-gray mb-1">{t('products.orderLabel.forOrders')}</div>
        <ul className="space-y-1">
          {lines.map(({ tag, text: line }) => (
            <li key={tag.product_order_id}>
              <button
                type="button"
                disabled={tag.base_order_id == null}
                onClick={() => goTo(tag)}
                className="flex items-center gap-1.5 text-left text-white hover:underline disabled:no-underline disabled:cursor-default"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tag.source_kind ?? ''] ?? 'bg-bambu-gray'}`} />
                <span className={urgency(tag)}>{line}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <span ref={box} className="relative inline-flex min-w-0">
      <button
        type="button"
        title={lines.length ? lines.map((l) => l.text).join('\n') : t('products.orderLabel.forStockTitle')}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (lines.length) setOpen((v) => !v);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-bambu-dark-tertiary max-w-[160px] min-w-0 pointer-coarse:py-2 ${
          lines.length ? urgency(main) : 'text-bambu-gray'
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            lines.length ? (DOT[main?.source_kind ?? ''] ?? 'bg-bambu-gray') : 'bg-bambu-gray/60'
          }`}
        />
        <span className="truncate">{text}</span>
      </button>
      {open && (
        <span
          className="absolute left-0 top-full mt-1 z-40 w-72 max-w-[80vw] rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl p-1"
          onClick={(e) => e.stopPropagation()}
        >
          {lines.map(({ tag, text: line }) => (
            <button
              key={tag.product_order_id}
              type="button"
              disabled={tag.base_order_id == null}
              onClick={() => goTo(tag)}
              className="w-full flex items-center gap-2 px-2 min-h-11 text-left text-xs rounded hover:bg-bambu-dark-tertiary disabled:hover:bg-transparent"
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tag.source_kind ?? ''] ?? 'bg-bambu-gray'}`} />
              <span className={`flex-1 min-w-0 ${urgency(tag)}`}>{line}</span>
              {tag.base_order_id != null && <ChevronRight className="w-4 h-4 text-bambu-gray shrink-0" />}
            </button>
          ))}
          <span className="block px-2 py-1.5 text-[11px] text-bambu-gray">{t('products.orderLabel.planned')}</span>
        </span>
      )}
    </span>
  );
}
