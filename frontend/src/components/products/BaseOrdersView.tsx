import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Link2Off, Loader2, PackageCheck, RefreshCw, Settings2, ShoppingBag } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseSyncResult, Permission } from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDateOnly, formatDateTime, parseUTCDate } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import { useUndoToast } from '../../hooks/useUndoToast';
import { ConfirmModal } from '../ConfirmModal';
import { BaseSettingsModal } from './BaseSettingsModal';
import { AcceptOrderModal } from './AcceptOrderModal';

// Bigger tap targets on a touch screen (an iPad at a printer), whatever its width.
const TOUCH = 'pointer-coarse:min-h-11!';

type Filter = 'new' | 'accepted' | 'skipped' | 'cancelled' | 'all';

interface BaseOrdersViewProps {
  hasPermission: (p: Permission) => boolean;
}

const selectClass =
  'px-2 py-1 pointer-coarse:py-2.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/** Products an order's mapped lines want: product id -> units. */
function wantedUnits(order: BaseOrder): Map<number, number> {
  const wanted = new Map<number, number>();
  for (const line of order.lines) {
    if (line.mapping === 'product' && line.product_id != null) {
      wanted.set(line.product_id, (wanted.get(line.product_id) ?? 0) + line.quantity * line.units);
    }
  }
  return wanted;
}

/** Whole local days from today to a date (negative: past). */
function daysUntil(iso: string): number | null {
  const date = parseUTCDate(iso);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

/** The ship-by date as a coloured label: late, today, tomorrow, or the date. */
function ShipByBadge({ shipBy, done }: { shipBy: string; done: boolean }) {
  const { t } = useTranslation();
  const days = daysUntil(shipBy);
  const date = formatDateOnly(shipBy, { weekday: 'short', day: 'numeric', month: 'short' });
  if (done || days === null || days > 1) {
    return <span className="text-xs text-bambu-gray-light">{t('baseSync.shipBy', { date })}</span>;
  }
  const late = (parseUTCDate(shipBy)?.getTime() ?? 0) < Date.now();
  const [label, style] = late
    ? [t('baseSync.shipLate'), 'bg-red-500/20 text-red-600 dark:text-red-300']
    : days <= 0
      ? [t('baseSync.shipToday'), 'bg-amber-500/20 text-amber-700 dark:text-amber-300']
      : [t('baseSync.shipTomorrow'), 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-200'];
  return (
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${style}`} title={t('baseSync.shipBy', { date })}>
      {label}
    </span>
  );
}

/**
 * Fork (Base sync): orders read from Base (base.com), read-only.
 *
 * Orders in the chosen Base status come in every few minutes. Their lines map
 * to products by SKU; a new order waits here for "Print" unless orders are
 * accepted automatically. Nothing is written back to Base.
 */
export function BaseOrdersView({ hasPermission }: BaseOrdersViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  const canAct = hasPermission('queue:create' as Permission);
  const canConfigure = hasPermission('settings:update' as Permission);
  const [filter, setFilter] = useState<Filter>('new');
  const [showSettings, setShowSettings] = useState(false);
  // The order being sent to production line by line (or changed).
  const [choosing, setChoosing] = useState<BaseOrder | null>(null);
  // The accepted order about to be taken out of production.
  const [withdrawing, setWithdrawing] = useState<BaseOrder | null>(null);
  const undoToast = useUndoToast();

  const { data: settings } = useQuery({ queryKey: ['base-sync', 'settings'], queryFn: api.getBaseSyncSettings });
  const configured = !!settings?.token_set && settings.status_ids.length > 0;
  const { data: orders, isLoading } = useQuery({
    queryKey: ['base-sync', 'orders', filter],
    queryFn: () => api.getBaseOrders(filter === 'all' ? undefined : filter),
    enabled: configured,
    refetchInterval: 60_000,
  });
  const { data: skus } = useQuery({ queryKey: ['base-sync', 'skus'], queryFn: api.getBaseSkus, enabled: configured });
  const { data: products } = useQuery({ queryKey: ['products'], queryFn: api.getProducts, enabled: configured });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['base-sync'] });
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['product'] });
    queryClient.invalidateQueries({ queryKey: ['queue'] });
  };

  const syncMutation = useMutation({
    mutationFn: api.runBaseSync,
    onSuccess: (result: BaseSyncResult) => {
      refresh();
      showToast(t('baseSync.toast.synced', { seen: result.seen, created: result.new }), 'success');
    },
    onError: (e: Error) => {
      refresh();
      showToast(e.message, 'error');
    },
  });
  const resetMutation = useMutation({
    mutationFn: (order: BaseOrder) => api.resetBaseOrder(order.order_id),
    onSuccess: () => {
      refresh();
      showToast(t('baseSync.toast.undone'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const orderMutation = useMutation({
    mutationFn: ({ order, action }: { order: BaseOrder; action: 'accept' | 'skip' | 'withdraw' }) =>
      action === 'accept' ? api.acceptBaseOrder(order.order_id) : api.skipBaseOrder(order.order_id),
    onSuccess: (_, { order, action }) => {
      refresh();
      setWithdrawing(null);
      const message = t(
        action === 'accept'
          ? 'baseSync.toast.accepted'
          : action === 'withdraw'
            ? 'baseSync.toast.withdrawn'
            : 'baseSync.toast.skipped',
      );
      // Sending or skipping a waiting order can be taken back for a moment.
      if (action === 'withdraw') showToast(message, 'success');
      else undoToast(message, () => resetMutation.mutate(order));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const skuMutation = useMutation({
    mutationFn: ({ sku, productId }: { sku: string; productId: number | null }) =>
      api.mapBaseSku(sku, { product_id: productId }),
    onSuccess: () => {
      refresh();
      showToast(t('baseSync.toast.mapped'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const filters: Filter[] = ['new', 'accepted', 'skipped', 'cancelled', 'all'];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="text-sm text-bambu-gray flex items-center gap-2 min-w-0">
          {settings?.enabled && configured ? (
            <CheckCircle2 className="w-4 h-4 text-bambu-green shrink-0" />
          ) : (
            <Link2Off className="w-4 h-4 shrink-0" />
          )}
          <span className="truncate">
            {!configured
              ? t('baseSync.notConfigured')
              : settings?.enabled
                ? t('baseSync.on', { minutes: settings.poll_minutes })
                : t('baseSync.off')}
            {settings?.last_ok_at && ` · ${t('baseSync.lastSync', { when: formatDateTime(settings.last_ok_at, timeFormat) })}`}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {configured && canAct && (
            <Button
              size="sm"
              variant="secondary"
              className={TOUCH}
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
            >
              <RefreshCw className={`w-4 h-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
              {t('baseSync.syncNow')}
            </Button>
          )}
          {canConfigure && (
            <Button size="sm" variant="ghost" className={TOUCH} onClick={() => setShowSettings(true)}>
              <Settings2 className="w-4 h-4" />
              {t('baseSync.settingsButton')}
            </Button>
          )}
        </div>
      </div>

      {settings?.last_error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 mb-4 text-sm text-red-600 dark:text-red-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{t('baseSync.lastError', { error: settings.last_error })}</span>
        </div>
      )}

      {!configured ? (
        <Card className="p-12 text-center border-dashed">
          <ShoppingBag className="w-16 h-16 text-bambu-gray mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-medium text-white mb-2">{t('baseSync.emptyTitle')}</h3>
          <p className="text-bambu-gray max-w-lg mx-auto mb-4">{t('baseSync.emptyDescription')}</p>
          {canConfigure && <Button onClick={() => setShowSettings(true)}>{t('baseSync.connect')}</Button>}
        </Card>
      ) : (
        <>
          {!!skus?.unmapped.length && (
            <Card className="p-4 mb-4">
              <h3 className="text-sm font-semibold text-white mb-1">{t('baseSync.unmappedTitle')}</h3>
              <p className="text-xs text-bambu-gray mb-3">{t('baseSync.unmappedHint')}</p>
              <ul className="divide-y divide-bambu-dark-tertiary">
                {skus.unmapped.map((entry) => (
                  <UnmappedRow
                    key={entry.sku}
                    sku={entry.sku}
                    name={entry.name}
                    orders={entry.orders}
                    products={products ?? []}
                    disabled={!canAct || skuMutation.isPending}
                    onMap={(productId) => skuMutation.mutate({ sku: entry.sku, productId })}
                  />
                ))}
              </ul>
            </Card>
          )}

          <div className="flex flex-wrap gap-1.5 mb-3">
            {filters.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`text-sm px-3.5 py-1.5 pointer-coarse:py-2.5 rounded-full border transition-colors ${
                  filter === value
                    ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
                    : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-gray'
                }`}
              >
                {t(`baseSync.filter.${value}`)}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-bambu-gray">{t('common.loading')}</div>
          ) : !orders?.length ? (
            <p className="text-sm text-bambu-gray py-6 text-center">{t('baseSync.noOrders')}</p>
          ) : (
            <div className="space-y-2">
              {orders.map((order) => (
                <Card key={order.order_id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-white font-medium">#{order.number ?? order.order_id}</span>
                    <span className="text-xs text-bambu-gray">{order.source_name ?? order.source}</span>
                    {order.date_confirmed && (
                      <span className="text-xs text-bambu-gray">{formatDateTime(order.date_confirmed, timeFormat)}</span>
                    )}
                    {order.ship_by && (
                      <ShipByBadge shipBy={order.ship_by} done={order.ready || order.state === 'cancelled' || !order.in_status} />
                    )}
                    <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-dark-tertiary text-bambu-gray-light">
                      {t(`baseSync.state.${order.state}`)}
                    </span>
                    {order.ready && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-green/15 text-bambu-green flex items-center gap-1">
                        <PackageCheck className="w-3.5 h-3.5" />
                        {t('baseSync.ready')}
                      </span>
                    )}
                    {!order.in_status && order.state !== 'cancelled' && (
                      <span className="text-xs text-bambu-gray">{t('baseSync.movedOn')}</span>
                    )}
                    {canAct && (
                      <span className="ml-auto flex flex-wrap justify-end gap-1.5">
                        {order.state === 'accepted' && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className={`${TOUCH} text-red-500 mr-3`}
                              onClick={() => setWithdrawing(order)}
                              disabled={orderMutation.isPending}
                            >
                              {t('baseSync.withdraw')}
                            </Button>
                            {order.lines.some((line) => line.mapping === 'product') && (
                              <Button size="sm" variant="secondary" className={TOUCH} onClick={() => setChoosing(order)}>
                                {t('baseSync.change')}
                              </Button>
                            )}
                          </>
                        )}
                        {order.state === 'new' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className={TOUCH}
                            onClick={() => orderMutation.mutate({ order, action: 'skip' })}
                            disabled={orderMutation.isPending}
                          >
                            {t('baseSync.skip')}
                          </Button>
                        )}
                        {(order.state === 'new' || order.state === 'skipped') &&
                          order.lines.some((line) => line.mapping === 'product') && (
                            <Button size="sm" variant="secondary" className={TOUCH} onClick={() => setChoosing(order)}>
                              {t('baseSync.choose')}
                            </Button>
                          )}
                        {(order.state === 'new' || order.state === 'skipped') && (
                          <Button
                            size="sm"
                            className={TOUCH}
                            onClick={() => orderMutation.mutate({ order, action: 'accept' })}
                            disabled={orderMutation.isPending}
                          >
                            {orderMutation.isPending && orderMutation.variables?.order.order_id === order.order_id && (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            )}
                            {t('baseSync.acceptAll')}
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1">
                    {order.lines.map((line, index) => (
                      <li key={`${line.sku}-${index}`} className="text-sm flex flex-wrap items-center gap-2">
                        <span className="text-white">{line.quantity}×</span>
                        <span className="text-bambu-gray-light">{line.name}</span>
                        <span className="text-xs text-bambu-gray">{line.sku}</span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            line.mapping === 'product'
                              ? 'bg-bambu-green/15 text-bambu-green'
                              : line.mapping === 'unmapped'
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                                : 'bg-bambu-dark-tertiary text-bambu-gray'
                          }`}
                        >
                          {line.mapping === 'product'
                            ? line.units > 1
                              ? `${line.product_name} ×${line.units}`
                              : line.product_name
                            : t(`baseSync.mapping.${line.mapping}`)}
                        </span>
                        {line.product_id != null &&
                          (order.held?.[String(line.product_id)] ?? 0) > 0 &&
                          // Held back per product: said once, on its first line.
                          order.lines.findIndex((other) => other.product_id === line.product_id) === index && (
                          <span className="text-xs text-amber-600 dark:text-amber-300">
                            {t('baseSync.heldBack', {
                              print:
                                (wantedUnits(order).get(line.product_id) ?? 0) - (order.held?.[String(line.product_id)] ?? 0),
                              total: wantedUnits(order).get(line.product_id) ?? 0,
                            })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {order.product_orders.some((po) => po.status !== 'cancelled') && (
                    <p className="text-xs text-bambu-gray mt-2">
                      {order.product_orders
                        .filter((po) => po.status !== 'cancelled')
                        .map((po) => {
                          const name = products?.find((p) => p.id === po.product_id)?.name ?? `#${po.product_id}`;
                          return `${name} ×${po.quantity}: ${t(`baseSync.productOrder.${po.status}`)}`;
                        })
                        .join(' · ')}
                    </p>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {showSettings && <BaseSettingsModal onClose={() => setShowSettings(false)} onSaved={refresh} />}
      {withdrawing && (
        <ConfirmModal
          title={t('baseSync.withdrawTitle', { number: withdrawing.number ?? withdrawing.order_id })}
          message={t('baseSync.withdrawMessage')}
          confirmText={t('baseSync.withdraw')}
          variant="danger"
          isLoading={orderMutation.isPending}
          onConfirm={() => orderMutation.mutate({ order: withdrawing, action: 'withdraw' })}
          onCancel={() => setWithdrawing(null)}
        />
      )}
      {choosing && (
        <AcceptOrderModal
          order={choosing}
          onClose={() => setChoosing(null)}
          onDone={() => {
            const wasAccepted = choosing.state === 'accepted';
            setChoosing(null);
            refresh();
            showToast(t(wasAccepted ? 'baseSync.toast.changed' : 'baseSync.toast.accepted'), 'success');
          }}
        />
      )}
    </div>
  );
}

function UnmappedRow({
  sku,
  name,
  orders,
  products,
  disabled,
  onMap,
}: {
  sku: string;
  name: string;
  orders: number;
  products: { id: number; name: string }[];
  disabled: boolean;
  onMap: (productId: number | null) => void;
}) {
  const { t } = useTranslation();
  const [productId, setProductId] = useState<number | ''>('');
  return (
    <li className="py-2 flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-white truncate">{name || sku}</span>
        <span className="block text-xs text-bambu-gray">
          {sku} · {t('baseSync.inOrders', { n: orders })}
        </span>
      </span>
      <select
        className={selectClass}
        value={productId}
        aria-label={t('baseSync.chooseProduct', { sku })}
        onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}
      >
        <option value="">{t('baseSync.chooseProductPlaceholder')}</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        className={TOUCH}
        disabled={disabled || productId === ''}
        onClick={() => productId !== '' && onMap(productId)}
      >
        {t('baseSync.map')}
      </Button>
      <Button size="sm" variant="ghost" className={TOUCH} disabled={disabled} onClick={() => onMap(null)}>
        {t('baseSync.notPrinted')}
      </Button>
    </li>
  );
}
