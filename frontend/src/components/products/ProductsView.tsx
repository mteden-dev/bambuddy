import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  ShoppingBag,
  ShoppingCart,
  Timer,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import type {
  Permission,
  Product,
  ProductDetail,
  ProductOrder,
  ProductPlanResult,
  ProductSettingsUpdate,
} from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { NumberInput } from '../NumberInput';
import { FocusedConfirmModal } from '../FocusedConfirmModal';
import { useToast } from '../../contexts/ToastContext';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDateTime } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import {
  baseOrderIdOf,
  groupJobs,
  invalidatePlanQueries,
  partName,
  partsSummary,
  piecesText,
  planSummary,
} from '../../utils/products';
import { isLate, shortWhen } from '../../utils/baseOrders';
import { PlateTime } from './PlateTime';
import { usePlanReport } from './usePlanReport';
import { ProductEditorModal } from './ProductEditorModal';
import { ProductOrderModal } from './ProductOrderModal';

interface ProductsViewProps {
  hasPermission: (p: Permission) => boolean;
}

// 16 px on a phone (a smaller field makes iOS zoom in), 44 px tall on touch.
const inputClass =
  'px-2 py-1 any-pointer-coarse:min-h-[44px] bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-base sm:text-sm focus:border-bambu-green focus:outline-none';
// Small buttons stay 44 px on a touch screen of any width (Button drops its min height from md).
const TOUCH = 'any-pointer-coarse:min-h-[44px]!';
const TOUCH_ICON = 'any-pointer-coarse:min-h-[44px]! any-pointer-coarse:min-w-[44px]!';

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
  const planNote = usePlanReport();
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
    mutationFn: (patch: Partial<ProductSettingsUpdate>) =>
      api.updateProductSettings({ plate_cost_minutes: productSettings?.plate_cost_minutes ?? 15, ...patch }),
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
    const parts = [t(key, values)];
    if (when) parts.push(t('products.toast.finishAt', { when }));
    // The counts above are this product's; a plan can redo others that share its printers.
    const note = planNote(result);
    if (note) parts.push(note);
    showToast(parts.join(' '), 'success');
    if (result.short.length) {
      showToast(
        t('products.toast.short', { parts: piecesText(result.product, result.short) }),
        'error',
      );
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-end gap-3 mb-4">
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

      {productSettings?.sjf_enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 mb-4 text-sm text-amber-600 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{t('products.sjfWarning')}</span>
        </div>
      )}

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
                if (minutes !== productSettings.plate_cost_minutes) settingsMutation.mutate({ plate_cost_minutes: minutes });
              }}
            />
            {t('products.settings.minutes')}
          </label>
          <p className="text-xs text-bambu-gray mt-2">{t('products.settings.plateCostHint')}</p>

          <div className="border-t border-bambu-dark-tertiary mt-4 pt-4 space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-white">
                <span>{t('products.settings.preferMargin')}</span>
                <span className="flex items-center gap-2">
                  <SettingNumber
                    value={productSettings.prefer_margin_minutes ?? 30}
                    max={1440}
                    label={t('products.settings.preferMargin')}
                    disabled={!canSettings || settingsMutation.isPending}
                    onSave={(n) => settingsMutation.mutate({ prefer_margin_minutes: n })}
                  />
                  {t('products.settings.minutes')}
                </span>
                <span>{t('products.settings.preferOr')}</span>
                <span className="flex items-center gap-2">
                  <SettingNumber
                    value={productSettings.prefer_margin_pct ?? 25}
                    max={100}
                    label={t('products.settings.preferPct')}
                    disabled={!canSettings || settingsMutation.isPending}
                    onSave={(n) => settingsMutation.mutate({ prefer_margin_pct: n })}
                  />
                  {t('products.settings.preferPct')}
                </span>
              </div>
              <p className="text-xs text-bambu-gray mt-2">{t('products.settings.preferHint')}</p>
            </div>
            <div>
              <label className="flex flex-wrap items-center gap-2 text-sm text-white">
                {t('products.settings.swap')}
                <span className="flex items-center gap-2">
                  <SettingNumber
                    value={productSettings.filament_swap_minutes ?? 10}
                    max={240}
                    label={t('products.settings.swap')}
                    disabled={!canSettings || settingsMutation.isPending}
                    onSave={(n) => settingsMutation.mutate({ filament_swap_minutes: n })}
                  />
                  {t('products.settings.minutes')}
                </span>
              </label>
              <p className="text-xs text-bambu-gray mt-2">{t('products.settings.swapHint')}</p>
            </div>
            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                className="w-5 h-5 mt-0.5 shrink-0 accent-bambu-green"
                checked={productSettings.force_color ?? true}
                disabled={!canSettings || settingsMutation.isPending}
                onChange={(e) => settingsMutation.mutate({ force_color: e.target.checked })}
              />
              <span className="text-sm text-white">
                {t('products.settings.forceColor')}
                <span className="block text-xs text-bambu-gray">{t('products.settings.forceColorHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                className="w-5 h-5 mt-0.5 shrink-0 accent-bambu-green"
                checked={productSettings.hand_prints_count ?? false}
                disabled={!canSettings || settingsMutation.isPending}
                onChange={(e) => settingsMutation.mutate({ hand_prints_count: e.target.checked })}
              />
              <span className="text-sm text-white">
                {t('products.settings.handPrints')}
                <span className="block text-xs text-bambu-gray">{t('products.settings.handPrintsHint')}</span>
              </span>
            </label>
          </div>

          <div className="border-t border-bambu-dark-tertiary mt-4 pt-4 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-bambu-gray">
              {t('products.advanced.title')}
            </h3>
            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                className="w-5 h-5 mt-0.5 shrink-0 accent-bambu-green"
                checked={productSettings.reservation_yield ?? true}
                disabled={!canSettings || settingsMutation.isPending}
                onChange={(e) => settingsMutation.mutate({ reservation_yield: e.target.checked })}
              />
              <span className="text-sm text-white">
                {t('products.advanced.reservationYield')}
                <span className="block text-xs text-bambu-gray">{t('products.advanced.reservationYieldHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                className="w-5 h-5 mt-0.5 shrink-0 accent-bambu-green"
                checked={productSettings.learn_history ?? true}
                disabled={!canSettings || settingsMutation.isPending}
                onChange={(e) => settingsMutation.mutate({ learn_history: e.target.checked })}
              />
              <span className="text-sm text-white">
                {t('products.advanced.learnHistory')}
                <span className="block text-xs text-bambu-gray">{t('products.advanced.learnHistoryHint')}</span>
              </span>
            </label>
          </div>
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
              {/* On a phone the name gets the first line (two lines of it if need be); the badge and
                  the buttons wrap under it, so two products named alike stay apart. */}
              <div className="flex flex-wrap items-center gap-3 p-4">
                <button
                  type="button"
                  className="flex items-center gap-2 min-w-0 flex-1 basis-56 text-left"
                  onClick={() => setExpanded((id) => (id === product.id ? null : product.id))}
                  aria-expanded={expanded === product.id}
                >
                  {expanded === product.id ? (
                    <ChevronDown className="w-4 h-4 text-bambu-gray shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-bambu-gray shrink-0" />
                  )}
                  <span className="w-12 h-12 rounded-lg bg-bambu-dark overflow-hidden flex items-center justify-center shrink-0">
                    {product.has_thumbnail ? (
                      <img
                        src={api.getProductThumbnailUrl(product.id, product.thumbnail_version)}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Boxes className="w-5 h-5 text-bambu-gray" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-white font-medium line-clamp-2 break-words">{product.name}</span>
                    <span className="block text-xs text-bambu-gray truncate">
                      {partsSummary(product.parts)} · {t('products.plateCount', { n: product.plates.length })}
                    </span>
                  </span>
                </button>
                {product.open_orders > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-bambu-green/15 text-bambu-green whitespace-nowrap">
                    {t('products.openOrders', { orders: product.open_orders, units: product.open_units })}
                  </span>
                )}
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      className={TOUCH}
                      onClick={() => setOrdering({ product })}
                      disabled={!product.plates.length}
                    >
                      <ShoppingCart className="w-4 h-4" />
                      {t('products.order.button')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={TOUCH_ICON}
                      onClick={() => setEditing(product)}
                      aria-label={t('common.edit')}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={TOUCH_ICON}
                      onClick={() => setDeleting(product)}
                      aria-label={t('common.delete')}
                    >
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
        <FocusedConfirmModal
          title={t('products.deleteTitle')}
          message={t('products.deleteMessage', { name: deleting.name })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleteMutation.isPending}
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
    // Other products and Base orders may have been replanned with it.
    invalidatePlanQueries(queryClient);
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
  const jobGroups = groupJobs(detail.jobs);

  return (
    // From xl the orders and the queue are on the left, the stock on the right:
    // no row stretches across a wide screen.
    <div className="border-t border-bambu-dark-tertiary p-4 space-y-5 xl:space-y-0 xl:grid xl:grid-cols-2 xl:gap-x-8 xl:gap-y-5 xl:items-start">
      {detail.unplanned.length > 0 && (
        <div className="xl:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{t('products.unplanned', { parts: piecesText(detail, detail.unplanned) })}</span>
        </div>
      )}

      <div className="space-y-5 min-w-0">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-semibold text-white">{t('products.orders')}</h3>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className={`ml-auto ${TOUCH}`}
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
              {openOrders.map((order) => {
                const baseId = baseOrderIdOf(order);
                const late = isLate(order.estimated_ready_at, order.due_date);
                return (
                  <div key={order.id} className="rounded-lg border border-bambu-dark-tertiary p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
                          ? t('products.eta', { when: shortWhen(order.estimated_ready_at, timeFormat) })
                          : t(order.no_estimate_reason ? `products.noEtaReason.${order.no_estimate_reason}` : 'products.noEta')}
                      </span>
                      {late && (
                        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-600 dark:text-red-300">
                          {t('products.late')}
                        </span>
                      )}
                      {baseId != null ? (
                        // From Base: changed or cancelled there (the next read would undo it here).
                        <Link
                          to={`/orders?order=${baseId}`}
                          className="ml-auto inline-flex items-center gap-1.5 px-2 min-h-9 any-pointer-coarse:min-h-[44px] rounded-lg text-xs text-bambu-green hover:bg-bambu-dark-tertiary"
                        >
                          <ShoppingBag className="w-3.5 h-3.5 shrink-0" />
                          {t('products.baseOrder', { label: order.notes || `Base ${baseId}` })}
                        </Link>
                      ) : (
                        canEdit && (
                          <span className="ml-auto flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className={TOUCH_ICON}
                              onClick={() => onEditOrder(detail, order)}
                              aria-label={t('common.edit')}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={TOUCH_ICON}
                              onClick={() => setCancelling(order)}
                              aria-label={t('products.cancelOrder')}
                            >
                              <XCircle className="w-4 h-4" />
                            </Button>
                          </span>
                        )
                      )}
                    </div>
                    {baseId != null ? (
                      <p className="text-xs text-bambu-gray mt-1">{t('products.baseOrderHint')}</p>
                    ) : (
                      order.notes && <p className="text-xs text-bambu-gray mt-1">{order.notes}</p>
                    )}
                    <div className="flex flex-wrap gap-3 mt-2">
                      {order.parts.map((p) => (
                        <span key={p.part_id} className="text-xs text-bambu-gray-light">
                          {partName(detail, p.part_id)}: {p.ready}/{p.needed}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-semibold text-white mb-2">{t('products.jobs')}</h3>
          {detail.jobs.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('products.noJobs')}</p>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary">
              {jobGroups.map(({ job, count }) => {
                const row = (
                  <>
                    <span className="text-white">
                      {/* In words, so it does not read as "2× 1× Base". */}
                      {count > 1 && (
                        <span className="font-semibold">{t('products.groupedPlates', { count })} · </span>
                      )}
                      {piecesText(detail, job.pieces)}
                    </span>
                    <span className="text-xs text-bambu-gray truncate min-w-0">{job.filename}</span>
                    <PlateTime plate={job} />
                    <span className="ml-auto flex flex-wrap items-center gap-1 text-xs text-bambu-gray-light">
                      {(job.by_hand || job.moved) && (
                        <span
                          className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300"
                          title={t('products.handHint')}
                        >
                          {t(job.by_hand ? 'products.byHand' : 'products.movedByHand')}
                        </span>
                      )}
                      {job.counted === false && (
                        <span
                          className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          title={t('products.notCountedHint')}
                        >
                          {t('products.notCounted')}
                        </span>
                      )}
                      {job.pinned && <Pin className="w-3.5 h-3.5" aria-label={t('products.pinned')} />}
                      {job.printer_name ?? t('products.anyPrinter')}
                      <span
                        className={`px-1.5 py-0.5 rounded ${
                          job.status === 'printing' ? 'bg-bambu-green/15 text-bambu-green' : 'bg-bambu-dark-tertiary'
                        }`}
                      >
                        {t(`products.jobStatus.${job.status}`)}
                      </span>
                      {job.queue_item_id != null && <ChevronRight className="w-4 h-4 text-bambu-gray" />}
                    </span>
                  </>
                );
                const rowClass = 'flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm';
                return (
                  <li key={job.id}>
                    {job.queue_item_id != null ? (
                      // Opens the (first) job on the queue page.
                      <Link
                        to={`/queue?tab=timeline&item=${job.queue_item_id}`}
                        aria-label={t('products.openInQueue', { name: job.filename ?? piecesText(detail, job.pieces) })}
                        className={`${rowClass} min-h-[44px] -mx-2 px-2 rounded-lg hover:bg-bambu-dark-tertiary/60`}
                      >
                        {row}
                      </Link>
                    ) : (
                      <div className={rowClass}>{row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="space-y-5 min-w-0">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-semibold text-white">{t('products.stock')}</h3>
            {canEdit && (
              <Button variant="ghost" size="sm" className={`ml-auto ${TOUCH}`} onClick={() => setCorrecting((v) => !v)}>
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
          {detail.parts.some((p) => p.finish_minutes > 0) && (
            <p className="text-xs text-bambu-gray mt-1 flex items-center gap-1">
              <Timer className="w-3.5 h-3.5" />
              {t('products.finishNote', {
                parts: detail.parts
                  .filter((p) => p.finish_minutes > 0)
                  .map((p) => `${p.name} ${p.finish_minutes} min`)
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
      </div>
      {cancelling && (
        <FocusedConfirmModal
          title={t('products.cancelOrderTitle')}
          message={t('products.cancelOrderMessage', { quantity: cancelling.quantity })}
          confirmText={t('products.cancelOrder')}
          variant="warning"
          isLoading={cancelMutation.isPending}
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
  const [mode, setMode] = useState<'adjust' | 'move'>('adjust');
  const [partId, setPartId] = useState(detail.parts[0]?.id ?? 0);
  const [printerId, setPrinterId] = useState(0);
  const [targetId, setTargetId] = useState(0);
  const [delta, setDelta] = useState(-1);
  const [pieces, setPieces] = useState(1);
  const [note, setNote] = useState('');
  const { data: printers } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });

  const mutation = useMutation({
    mutationFn: () =>
      mode === 'move'
        ? api.moveProductStock(detail.id, {
            part_id: partId,
            from_printer_id: printerId || null,
            to_printer_id: targetId || null,
            pieces,
            note: note.trim() || null,
          })
        : api.adjustProductStock(detail.id, {
            part_id: partId,
            printer_id: printerId || null,
            delta,
            note: note.trim() || null,
          }),
    onSuccess: onDone,
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const printerSelect = (value: number, onChange: (id: number) => void) => (
    <select className={inputClass} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      <option value={0}>{t('products.unknownPrinter')}</option>
      {(printers ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  const invalid = mode === 'move' ? printerId === targetId : delta === 0;

  return (
    <form
      className="mt-3 rounded-lg border border-bambu-dark-tertiary p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) mutation.mutate();
      }}
    >
      <div className="flex gap-1 mb-3" role="tablist">
        {(['adjust', 'move'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={`text-xs px-3 py-1 any-pointer-coarse:min-h-[44px] rounded-full border transition-colors ${
              mode === value
                ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
                : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-gray'
            }`}
          >
            {t(value === 'move' ? 'products.stockModeMove' : 'products.stockModeAdjust')}
          </button>
        ))}
      </div>
      {mode === 'move' && <p className="text-xs text-bambu-gray mb-2">{t('products.stockMoveHint')}</p>}
      <div className="flex flex-wrap items-end gap-2">
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
          <span className="block mb-1">{t(mode === 'move' ? 'products.stockFrom' : 'products.stockPrinter')}</span>
          {printerSelect(printerId, setPrinterId)}
        </label>
        {mode === 'move' ? (
          <>
            <label className="text-xs text-bambu-gray">
              <span className="block mb-1">{t('products.stockTo')}</span>
              {printerSelect(targetId, setTargetId)}
            </label>
            <label className="text-xs text-bambu-gray">
              <span className="block mb-1">{t('products.stockPieces')}</span>
              <NumberInput
                min={1}
                max={10000}
                fallback={1}
                className={`${inputClass} w-20`}
                value={pieces}
                onChange={setPieces}
              />
            </label>
          </>
        ) : (
          <label className="text-xs text-bambu-gray">
            <span className="block mb-1">{t('products.stockDelta')}</span>
            <NumberInput min={-10000} max={10000} className={`${inputClass} w-20`} value={delta} onChange={setDelta} />
          </label>
        )}
        <label className="text-xs text-bambu-gray flex-1 min-w-[8rem]">
          <span className="block mb-1">{t('products.stockNote')}</span>
          <input className={`${inputClass} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button type="submit" size="sm" className={TOUCH} disabled={invalid || mutation.isPending}>
          {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {t('products.stockApply')}
        </Button>
      </div>
    </form>
  );
}

/** A whole number setting saved when the field is left, if it changed. */
function SettingNumber({
  value,
  max,
  label,
  disabled,
  onSave,
}: {
  value: number;
  max: number;
  label: string;
  disabled: boolean;
  onSave: (value: number) => void;
}) {
  return (
    <input
      key={value}
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      defaultValue={value}
      aria-label={label}
      disabled={disabled}
      className="w-20 px-2 py-1 any-pointer-coarse:min-h-[44px] bg-bambu-dark
 border border-bambu-dark-tertiary rounded-lg text-white text-base sm:text-sm focus:border-bambu-green focus:outline-none"
      onBlur={(e) => {
        const next = Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0)));
        if (next !== value) onSave(next);
      }}
    />
  );
}
