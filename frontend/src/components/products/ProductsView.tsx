import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Link2,
  Loader2,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Settings2,
  ShoppingCart,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import type { Permission, Product, ProductDetail, ProductOrder, ProductPlanResult } from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { NumberInput } from '../NumberInput';
import { ConfirmModal } from '../ConfirmModal';
import { useToast } from '../../contexts/ToastContext';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDateTime, formatDuration } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import { partName, partsSummary, piecesText, planSummary } from '../../utils/products';
import { ProductEditorModal } from './ProductEditorModal';
import { ProductOrderModal } from './ProductOrderModal';

interface ProductsViewProps {
  hasPermission: (p: Permission) => boolean;
}

const inputClass =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/**
 * Fork (products): the Products page (its own entry in the sidebar).
 *
 * A product is parts with sliced plates for them. Ordering some puts plates in
 * the queue; a new order (or a change, a cancel, a stock correction) plans the
 * product's open orders again, so two orders that arrive before printing
 * starts can share bigger plates. Lid and base marked "same printer" are
 * pinned to one printer.
 */
export function ProductsView({ hasPermission }: ProductsViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: settings } = useUiSettings();
  const timeFormat: TimeFormat = settings?.time_format || 'system';
  const canEdit = hasPermission('queue:create' as Permission);
  const canSettings = hasPermission('settings:update' as Permission);

  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [ordering, setOrdering] = useState<{ product: Product; order?: ProductOrder } | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const { data: products, isLoading } = useQuery({ queryKey: ['products'], queryFn: api.getProducts });
  const { data: productSettings } = useQuery({ queryKey: ['product-settings'], queryFn: api.getProductSettings });

  const settingsMutation = useMutation({
    mutationFn: (minutes: number) => api.updateProductSettings({ plate_cost_minutes: minutes }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['product-settings'], saved);
      showToast(t('products.settings.saved'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteProduct(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      setDeleting(null);
    },
    onError: (e: Error) => {
      setDeleting(null);
      showToast(e.message, 'error');
    },
  });

  const reportPlan = (result: ProductPlanResult) => {
    const { key, values } = planSummary(result);
    const when = result.finish_at ? formatDateTime(result.finish_at, timeFormat) : null;
    const message = when ? `${t(key, values)} ${t('products.toast.finishAt', { when })}` : t(key, values);
    showToast(message, 'success');
    if (result.short.length) {
      showToast(
        t('products.toast.short', { parts: piecesText(result.product, result.short) }),
        'error',
      );
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Boxes className="w-7 h-7 text-bambu-green" />
            {t('products.title')}
          </h1>
          <p className="text-bambu-gray mt-1">{t('products.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
            <Settings2 className="w-4 h-4" />
            {t('products.settings.button')}
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="w-4 h-4" />
              {t('products.newProduct')}
            </Button>
          )}
        </div>
      </div>

      {showSettings && productSettings && (
        <Card className="p-4 mb-4">
          <label className="flex flex-wrap items-center gap-2 text-sm text-white">
            {t('products.settings.plateCost')}
            <input
              key={productSettings.plate_cost_minutes}
              type="number"
              min={0}
              max={1440}
              defaultValue={productSettings.plate_cost_minutes}
              disabled={!canSettings || settingsMutation.isPending}
              className={`${inputClass} w-24`}
              onBlur={(e) => {
                const minutes = Math.max(0, Math.min(1440, Number(e.target.value) || 0));
                if (minutes !== productSettings.plate_cost_minutes) settingsMutation.mutate(minutes);
              }}
            />
            {t('products.settings.minutes')}
          </label>
          <p className="text-xs text-bambu-gray mt-2">{t('products.settings.plateCostHint')}</p>
        </Card>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-bambu-gray">{t('common.loading')}</div>
      ) : !products?.length ? (
        <Card className="p-12 text-center border-dashed">
          <Boxes className="w-16 h-16 text-bambu-gray mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-medium text-white mb-2">{t('products.emptyTitle')}</h3>
          <p className="text-bambu-gray max-w-lg mx-auto">{t('products.emptyDescription')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {products.map((product) => (
            <Card key={product.id} className="p-0 overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 p-4">
                <button
                  type="button"
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  onClick={() => setExpanded((id) => (id === product.id ? null : product.id))}
                  aria-expanded={expanded === product.id}
                >
                  {expanded === product.id ? (
                    <ChevronDown className="w-4 h-4 text-bambu-gray shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-bambu-gray shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-white font-medium truncate">{product.name}</span>
                    <span className="block text-xs text-bambu-gray truncate">
                      {partsSummary(product.parts)} · {t('products.plateCount', { n: product.plates.length })}
                    </span>
                  </span>
                </button>
                {product.open_orders > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-bambu-green/15 text-bambu-green">
                    {t('products.openOrders', { orders: product.open_orders, units: product.open_units })}
                  </span>
                )}
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <Button size="sm" onClick={() => setOrdering({ product })} disabled={!product.plates.length}>
                      <ShoppingCart className="w-4 h-4" />
                      {t('products.order.button')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(product)} aria-label={t('common.edit')}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(product)} aria-label={t('common.delete')}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
              {expanded === product.id && (
                <ProductDetailPanel
                  productId={product.id}
                  canEdit={canEdit}
                  timeFormat={timeFormat}
                  onEditOrder={(detail, order) => setOrdering({ product: detail, order })}
                  onPlanned={reportPlan}
                />
              )}
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <ProductEditorModal product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {ordering && (
        <ProductOrderModal
          product={ordering.product}
          order={ordering.order}
          onClose={() => setOrdering(null)}
          onPlanned={reportPlan}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={t('products.deleteTitle')}
          message={t('products.deleteMessage', { name: deleting.name })}
          confirmText={t('common.delete')}
          variant="danger"
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

interface ProductDetailPanelProps {
  productId: number;
  canEdit: boolean;
  timeFormat: TimeFormat;
  onEditOrder: (product: ProductDetail, order: ProductOrder) => void;
  onPlanned: (result: ProductPlanResult) => void;
}

function ProductDetailPanel({ productId, canEdit, timeFormat, onEditOrder, onPlanned }: ProductDetailPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [cancelling, setCancelling] = useState<ProductOrder | null>(null);
  const [correcting, setCorrecting] = useState(false);

  const { data: detail, isLoading } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.getProduct(productId),
    refetchInterval: 30_000,
  });

  const afterPlan = (result: ProductPlanResult) => {
    queryClient.setQueryData(['product', productId], result.product);
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    onPlanned(result);
  };

  const replanMutation = useMutation({
    mutationFn: () => api.replanProduct(productId),
    onSuccess: afterPlan,
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const cancelMutation = useMutation({
    mutationFn: (orderId: number) => api.cancelProductOrder(orderId),
    onSuccess: (result) => {
      setCancelling(null);
      afterPlan(result);
    },
    onError: (e: Error) => {
      setCancelling(null);
      showToast(e.message, 'error');
    },
  });

  if (isLoading || !detail) {
    return (
      <div className="flex justify-center py-6 border-t border-bambu-dark-tertiary">
        <Loader2 className="w-5 h-5 animate-spin text-bambu-gray" />
      </div>
    );
  }

  const openOrders = detail.orders.filter((o) => o.status === 'open');
  const closedOrders = detail.orders.filter((o) => o.status !== 'open');

  return (
    <div className="border-t border-bambu-dark-tertiary p-4 space-y-5">
      {detail.unplanned.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{t('products.unplanned', { parts: piecesText(detail, detail.unplanned) })}</span>
        </div>
      )}

      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-white">{t('products.orders')}</h3>
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => replanMutation.mutate()}
              disabled={replanMutation.isPending}
              title={t('products.replanHint')}
            >
              <RefreshCw className={`w-4 h-4 ${replanMutation.isPending ? 'animate-spin' : ''}`} />
              {t('products.replan')}
            </Button>
          )}
        </div>
        {openOrders.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('products.noOpenOrders')}</p>
        ) : (
          <div className="space-y-2">
            {openOrders.map((order) => (
              <div key={order.id} className="rounded-lg border border-bambu-dark-tertiary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-white font-medium">
                    {t('products.orderLine', { quantity: order.quantity, ready: order.units_ready })}
                  </span>
                  {order.due_date && (
                    <span className="text-xs text-bambu-gray">
                      {t('products.due', { when: formatDateTime(order.due_date, timeFormat) })}
                    </span>
                  )}
                  <span className="text-xs text-bambu-gray">
                    {order.estimated_ready_at
                      ? t('products.eta', { when: formatDateTime(order.estimated_ready_at, timeFormat) })
                      : t('products.noEta')}
                  </span>
                  {canEdit && (
                    <span className="ml-auto flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onEditOrder(detail, order)} aria-label={t('common.edit')}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCancelling(order)}
                        aria-label={t('products.cancelOrder')}
                      >
                        <XCircle className="w-4 h-4" />
                      </Button>
                    </span>
                  )}
                </div>
                {order.notes && <p className="text-xs text-bambu-gray mt-1">{order.notes}</p>}
                <div className="flex flex-wrap gap-3 mt-2">
                  {order.parts.map((p) => (
                    <span key={p.part_id} className="text-xs text-bambu-gray-light">
                      {partName(detail, p.part_id)}: {p.ready}/{p.needed}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-white mb-2">{t('products.jobs')}</h3>
        {detail.jobs.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('products.noJobs')}</p>
        ) : (
          <ul className="divide-y divide-bambu-dark-tertiary">
            {detail.jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="text-white">{piecesText(detail, job.pieces)}</span>
                <span className="text-xs text-bambu-gray truncate">{job.filename}</span>
                {job.print_time_seconds ? (
                  <span className="text-xs text-bambu-gray">{formatDuration(job.print_time_seconds)}</span>
                ) : null}
                <span className="ml-auto flex items-center gap-1 text-xs text-bambu-gray-light">
                  {job.pinned && <Pin className="w-3.5 h-3.5" aria-label={t('products.pinned')} />}
                  {job.printer_name ?? t('products.anyPrinter')}
                  <span
                    className={`px-1.5 py-0.5 rounded ${
                      job.status === 'printing' ? 'bg-bambu-green/15 text-bambu-green' : 'bg-bambu-dark-tertiary'
                    }`}
                  >
                    {t(`products.jobStatus.${job.status}`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-white">{t('products.stock')}</h3>
          {canEdit && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setCorrecting((v) => !v)}>
              {t('products.correctStock')}
            </Button>
          )}
        </div>
        {detail.stock.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('products.noStock')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {detail.stock.map((entry) => (
              <span
                key={`${entry.part_id}-${entry.printer_id}`}
                className="text-xs px-2 py-1 rounded-lg bg-bambu-dark-tertiary text-bambu-gray-light"
              >
                {entry.pieces}× {partName(detail, entry.part_id)} ·{' '}
                {entry.printer_id ? entry.printer_name ?? `#${entry.printer_id}` : t('products.unknownPrinter')}
              </span>
            ))}
          </div>
        )}
        {detail.parts.some((p) => p.matched) && (
          <p className="text-xs text-bambu-gray mt-2 flex items-center gap-1">
            <Link2 className="w-3.5 h-3.5" />
            {t('products.matchedNote', {
              parts: detail.parts
                .filter((p) => p.matched)
                .map((p) => p.name)
                .join(', '),
            })}
          </p>
        )}
        {correcting && <StockCorrection detail={detail} onDone={(result) => { setCorrecting(false); afterPlan(result); }} />}
      </section>

      {closedOrders.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-2">{t('products.closedOrders')}</h3>
          <ul className="text-xs text-bambu-gray space-y-1">
            {closedOrders.map((order) => (
              <li key={order.id}>
                {t(`products.orderStatus.${order.status}`)} · {order.quantity}× ·{' '}
                {formatDateTime(order.completed_at ?? order.created_at, timeFormat)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {cancelling && (
        <ConfirmModal
          title={t('products.cancelOrderTitle')}
          message={t('products.cancelOrderMessage', { quantity: cancelling.quantity })}
          confirmText={t('products.cancelOrder')}
          variant="warning"
          onConfirm={() => cancelMutation.mutate(cancelling.id)}
          onCancel={() => setCancelling(null)}
        />
      )}
    </div>
  );
}

function StockCorrection({ detail, onDone }: { detail: ProductDetail; onDone: (result: ProductPlanResult) => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [partId, setPartId] = useState(detail.parts[0]?.id ?? 0);
  const [printerId, setPrinterId] = useState(0);
  const [delta, setDelta] = useState(-1);
  const [note, setNote] = useState('');
  const { data: printers } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });

  const mutation = useMutation({
    mutationFn: () =>
      api.adjustProductStock(detail.id, {
        part_id: partId,
        printer_id: printerId || null,
        delta,
        note: note.trim() || null,
      }),
    onSuccess: onDone,
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-bambu-dark-tertiary p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (delta !== 0) mutation.mutate();
      }}
    >
      <label className="text-xs text-bambu-gray">
        <span className="block mb-1">{t('products.stockPart')}</span>
        <select className={inputClass} value={partId} onChange={(e) => setPartId(Number(e.target.value))}>
          {detail.parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-bambu-gray">
        <span className="block mb-1">{t('products.stockPrinter')}</span>
        <select className={inputClass} value={printerId} onChange={(e) => setPrinterId(Number(e.target.value))}>
          <option value={0}>{t('products.unknownPrinter')}</option>
          {(printers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-bambu-gray">
        <span className="block mb-1">{t('products.stockDelta')}</span>
        <NumberInput
          min={-10000}
          max={10000}
          className={`${inputClass} w-20`}
          value={delta}
          onChange={setDelta}
        />
      </label>
      <label className="text-xs text-bambu-gray flex-1 min-w-[8rem]">
        <span className="block mb-1">{t('products.stockNote')}</span>
        <input className={`${inputClass} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <Button type="submit" size="sm" disabled={delta === 0 || mutation.isPending}>
        {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
        {t('products.stockApply')}
      </Button>
    </form>
  );
}
