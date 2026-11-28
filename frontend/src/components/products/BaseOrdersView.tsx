import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Link2Off, RefreshCw, Search, Settings2, ShoppingBag, X } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseOrder, BaseOrderAcceptProduct, BaseOrderLine, BaseSyncResult, Permission } from '../../api/client';
import { Card } from '../Card';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDateTime } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import { useUndoToast } from '../../hooks/useUndoToast';
import { matchesSearch, ORDER_GRID, orderLate, SECTION_ORDER, sectionOf } from '../../utils/baseOrders';
import { invalidatePlanQueries } from '../../utils/products';
import type { OrderSection } from '../../utils/baseOrders';
import { BaseSettingsModal } from './BaseSettingsModal';
import { OrderPlatesModal } from './OrderPlatesModal';
import { OrderRow } from './OrderRow';
import { WithdrawOrderModal } from './WithdrawOrderModal';
import { usePlanReport, withNote } from './usePlanReport';
import { translateServerError } from '../../utils/serverMessages';

// Bigger tap targets on a touch screen (an iPad at a printer), whatever its width.
const TOUCH = 'any-pointer-coarse:min-h-[44px]!';

type Filter = 'new' | 'accepted' | 'ready' | 'skipped' | 'cancelled' | 'all';
type SourceFilter = 'all' | 'allegro' | 'shop';
const FILTERS: Filter[] = ['new', 'accepted', 'ready', 'skipped', 'cancelled', 'all'];
const SOURCES: SourceFilter[] = ['all', 'allegro', 'shop'];

interface BaseOrdersViewProps {
  hasPermission: (p: Permission) => boolean;
}

const selectClass =
  'px-2 py-1 pointer-coarse:py-2.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a private window: the choice is just not remembered
  }
}

/** The order the link (?order=<Base id>) points at, once. */
function linkedOrder(): number | null {
  const value = new URLSearchParams(window.location.search).get('order');
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

const chip = (active: boolean) =>
  `text-sm px-3.5 py-1.5 pointer-coarse:py-2.5 rounded-full border transition-colors ${
    active
      ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
      : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-gray'
  }`;

/**
 * Fork (Base sync): orders read from Base (base.com), read-only.
 *
 * Waiting and accepted orders are listed in the order they are to be made:
 * Allegro by ship-by date (today, tomorrow, the day after, later), then the
 * shop's oldest first. A row opens its parts: what to print and what is on
 * the shelf. Nothing is written back to Base.
 */
export function BaseOrdersView({ hasPermission }: BaseOrdersViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const undoToast = useUndoToast();
  const planNote = usePlanReport();
  const { data: ui } = useUiSettings();
  const timeFormat: TimeFormat = ui?.time_format || 'system';
  const canAct = hasPermission('queue:create' as Permission);
  const canConfigure = hasPermission('settings:update' as Permission);
  const [linked] = useState(linkedOrder);
  const [filter, setFilterState] = useState<Filter>(() =>
    linked != null ? 'all' : remembered('baseOrders.filter', FILTERS, 'new'),
  );
  const [source, setSourceState] = useState<SourceFilter>(() =>
    linked != null ? 'all' : remembered('baseOrders.source', SOURCES, 'all'),
  );
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(linked);
  const [showSettings, setShowSettings] = useState(false);
  // The accepted order about to be taken out of production.
  const [withdrawing, setWithdrawing] = useState<BaseOrder | null>(null);
  // The order whose planned plates are open (after sending it, or from its row).
  const [platesFor, setPlatesFor] = useState<BaseOrder | null>(null);
  const withdrawingNow = useRef(withdrawing);
  withdrawingNow.current = withdrawing;
  // Orders with a request under way, each on its own: one order's answer leaves the others' buttons alone.
  const [pendingIds, setPendingIds] = useState<Set<number>>(() => new Set());
  const markPending = (orderId: number, busy: boolean) =>
    setPendingIds((current) => {
      const next = new Set(current);
      if (busy) next.add(orderId);
      else next.delete(orderId);
      return next;
    });
  const tracked = {
    onMutate: ({ order }: { order: BaseOrder }) => markPending(order.order_id, true),
    onSettled: (_data: unknown, _error: unknown, { order }: { order: BaseOrder }) => markPending(order.order_id, false),
  };
  const setFilter = (value: Filter) => {
    setFilterState(value);
    remember('baseOrders.filter', value);
  };
  const setSource = (value: SourceFilter) => {
    setSourceState(value);
    remember('baseOrders.source', value);
  };

  const { data: settings } = useQuery({ queryKey: ['base-sync', 'settings'], queryFn: api.getBaseSyncSettings });
  const configured = !!settings?.token_set && settings.status_ids.length > 0;
  // A search looks through every state.
  const listed: Filter = search.trim() ? 'all' : filter;
  const ordersQuery = useQuery({
    queryKey: ['base-sync', 'orders', listed, source],
    queryFn: () => api.getBaseOrders(listed === 'all' ? undefined : listed, source === 'all' ? undefined : source),
    enabled: configured,
    refetchInterval: 60_000,
  });
  const { data: counts } = useQuery({
    queryKey: ['base-sync', 'counts'],
    queryFn: api.getBaseOrderCounts,
    enabled: configured,
    refetchInterval: 60_000,
  });
  const { data: skus } = useQuery({ queryKey: ['base-sync', 'skus'], queryFn: api.getBaseSkus, enabled: configured });
  const { data: products } = useQuery({ queryKey: ['products'], queryFn: api.getProducts, enabled: configured });
  const partNames = useMemo(
    () => new Map((products ?? []).flatMap((p) => p.parts.map((part) => [part.id, part.name] as const))),
    [products],
  );

  // The linked order: scrolled to once it is listed.
  useEffect(() => {
    if (linked == null || !ordersQuery.data) return;
    document.getElementById(`order-${linked}`)?.scrollIntoView?.({ block: 'center' });
  }, [linked, ordersQuery.data]);

  const refresh = () => invalidatePlanQueries(queryClient);

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
    mutationFn: ({ order }: { order: BaseOrder; restore: boolean }) => api.resetBaseOrder(order.order_id),
    ...tracked,
    onSuccess: (sent, { restore }) => {
      refresh();
      showToast(withNote(t(restore ? 'baseSync.toast.restored' : 'baseSync.toast.undone'), planNote(sent)), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const requeueMutation = useMutation({
    mutationFn: ({ order }: { order: BaseOrder }) => api.requeueBaseOrder(order.order_id),
    ...tracked,
    onSuccess: (sent: BaseOrder) => {
      refresh();
      // Still missing after a fresh plan: no plate (or no printer) can make it.
      const short = sent.progress.some((p) => p.parts.some((part) => part.missing > 0));
      showToast(
        withNote(t(short ? 'baseSync.toast.requeueShort' : 'baseSync.toast.requeued'), planNote(sent)),
        short ? 'warning' : 'success',
      );
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  // Undo of a withdrawal: sent again, with what was held back and on hand as before.
  const undoWithdrawMutation = useMutation({
    mutationFn: ({ order }: { order: BaseOrder }) => api.acceptBaseOrder(order.order_id),
    ...tracked,
    onSuccess: (sent) => {
      refresh();
      showToast(withNote(t('baseSync.toast.withdrawUndone'), planNote(sent)), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const orderMutation = useMutation({
    mutationFn: ({
      order,
      action,
      returnDone,
      body,
    }: {
      order: BaseOrder;
      action: 'accept' | 'skip' | 'withdraw';
      returnDone?: boolean;
      body?: { products: BaseOrderAcceptProduct[] };
    }) =>
      action === 'accept'
        ? api.acceptBaseOrder(order.order_id, body)
        : api.skipBaseOrder(order.order_id, action === 'withdraw' ? { return_done: !!returnDone } : undefined),
    ...tracked,
    onSuccess: (sent, { order, action }) => {
      refresh();
      // Only this order's dialog closes; another order's stays as it is.
      setWithdrawing((current) => (current?.order_id === order.order_id ? null : current));
      if (action !== 'accept') setExpanded((current) => (current === order.order_id ? null : current));
      const message = withNote(t(
        action === 'accept'
          ? sent.ready
            ? 'baseSync.toast.ready'
            : 'baseSync.toast.accepted'
          : action === 'withdraw'
            ? 'baseSync.toast.withdrawn'
            : 'baseSync.toast.skipped',
      ), planNote(sent));
      // Sending, skipping or withdrawing an order can be taken back for a moment.
      if (action === 'withdraw') undoToast(message, () => undoWithdrawMutation.mutate({ order }));
      else undoToast(message, () => resetMutation.mutate({ order, restore: false }));
      // Sent to print: the plates the plan chose, to prefer a printer for any; not over another dialog.
      if (action === 'accept' && sent.state === 'accepted' && !sent.ready && !withdrawingNow.current) {
        setPlatesFor((current) => current ?? sent);
      }
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  // "I have it" on one line (made by hand, no product yet): a toast only when that makes the order ready.
  const haveMutation = useMutation({
    mutationFn: ({ order, line, have }: { order: BaseOrder; line: BaseOrderLine; have: boolean }) =>
      api.setBaseOrderLineHave(order.order_id, { sku: line.sku, name: line.name, have }),
    ...tracked,
    onSuccess: (sent, { order }) => {
      refresh();
      if (sent.ready && !order.ready) showToast(withNote(t('baseSync.toast.ready'), planNote(sent)), 'success');
      else {
        const note = planNote(sent);
        if (note) showToast(note, 'success');
      }
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

  const orders = useMemo(
    () => (ordersQuery.data ?? []).filter((order) => matchesSearch(order, search)),
    [ordersQuery.data, search],
  );
  // Sections only where the list is in the order of making.
  const sectioned = !search.trim() && (filter === 'new' || filter === 'accepted');
  // The ready ones still to pack first, then the ones packed in Base.
  const packedApart = !search.trim() && filter === 'ready';
  const groups: { section: OrderSection | 'packed' | null; orders: BaseOrder[] }[] = sectioned
    ? SECTION_ORDER.map((section) => ({ section, orders: orders.filter((o) => sectionOf(o) === section) })).filter(
        (g) => g.orders.length,
      )
    : packedApart
      ? [
          { section: null, orders: orders.filter((o) => !o.packed) },
          { section: 'packed' as const, orders: orders.filter((o) => o.packed) },
        ].filter((g) => g.orders.length)
      : [{ section: null, orders }];
  const countFor = (state: string, kind: SourceFilter) => {
    const entry = counts?.[state];
    if (!entry) return null;
    return kind === 'all' ? entry.allegro + entry.shop : entry[kind];
  };

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
          <span>{t('baseSync.lastError', { error: translateServerError(settings.last_error) })}</span>
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

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((value) => {
                const n = value === 'new' || value === 'accepted' ? countFor(value, source) : null;
                return (
                  <button key={value} type="button" onClick={() => setFilter(value)} className={chip(filter === value)}>
                    {t(`baseSync.filter.${value}`)}
                    {n != null && n > 0 && <span className="ml-1.5 text-xs opacity-80">{n}</span>}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto lg:ml-auto">
              <div className="inline-flex rounded-lg border border-bambu-dark-tertiary overflow-hidden" role="group">
                {SOURCES.map((value) => {
                  const n = value === 'all' ? null : countFor(filter === 'all' ? 'new' : filter, value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={source === value}
                      onClick={() => setSource(value)}
                      className={`text-sm px-3.5 py-1.5 pointer-coarse:py-2.5 transition-colors ${
                        source === value
                          ? 'bg-bambu-green text-white'
                          : 'bg-bambu-dark text-bambu-gray-light hover:bg-bambu-dark-tertiary'
                      }`}
                    >
                      {t(`baseSync.source.${value}`)}
                      {n != null && n > 0 && <span className="ml-1.5 text-xs opacity-80">{n}</span>}
                    </button>
                  );
                })}
              </div>
              <label className="relative flex-1 min-w-[12rem] lg:w-72 lg:flex-none">
                <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('baseSync.searchPlaceholder')}
                  aria-label={t('baseSync.searchPlaceholder')}
                  className="w-full pl-9 pr-9 py-1.5 pointer-coarse:py-2.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label={t('baseSync.clearSearch')}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-2 text-bambu-gray hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </label>
            </div>
          </div>

          {ordersQuery.isLoading ? (
            <div className="space-y-1.5" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-20 rounded-xl bg-bambu-dark-secondary flex items-center gap-3 px-3 animate-pulse">
                  <div className="w-12 h-12 rounded-lg bg-bambu-dark-tertiary" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 rounded bg-bambu-dark-tertiary" />
                    <div className="h-3 w-2/3 rounded bg-bambu-dark-tertiary" />
                  </div>
                </div>
              ))}
            </div>
          ) : ordersQuery.isError ? (
            <Card className="p-6 text-center border border-red-500/40">
              <p role="alert" className="text-red-500 dark:text-red-400 mb-3">
                {t('baseSync.loadFailed')}
              </p>
              <Button variant="secondary" className={TOUCH} onClick={() => ordersQuery.refetch()}>
                {t('products.qc.retry')}
              </Button>
            </Card>
          ) : !orders.length ? (
            <EmptyState
              filter={filter}
              source={source}
              search={search}
              canSync={canAct}
              onSync={() => syncMutation.mutate()}
              onAllSources={() => setSource('all')}
              onClearSearch={() => setSearch('')}
            />
          ) : (
            <div className="space-y-4">
              {groups.map((group, groupIndex) => {
                const late = group.orders.filter(orderLate).length;
                return (
                <section key={group.section ?? 'all'}>
                  {group.section && (
                    // Sticks under the fixed compact header (--app-top), or at the top without one.
                    <h3 className="sticky top-[var(--app-top,0px)] z-10 bg-bambu-dark/95 backdrop-blur py-1.5 mb-1.5 text-xs font-semibold uppercase tracking-wide text-bambu-gray">
                      {t(`baseSync.section.${group.section}`)} · {group.orders.length}
                      {late > 0 && (
                        <span className="text-red-600 dark:text-red-300"> · {t('baseSync.sectionLate', { n: late })}</span>
                      )}
                    </h3>
                  )}
                  <div
                    className={`${groupIndex === 0 ? 'hidden xl:grid' : 'hidden'} ${ORDER_GRID} gap-3 px-3 pb-1 text-xs text-bambu-gray`}
                  >
                    <span>{t('baseSync.column.when')}</span>
                    <span>{t('baseSync.column.order')}</span>
                    <span>{t('baseSync.column.lines')}</span>
                    <span>{t('baseSync.column.progress')}</span>
                    <span />
                  </div>
                  <div className="space-y-1.5">
                    {group.orders.map((order) => (
                      <OrderRow
                        key={order.order_id}
                        order={order}
                        expanded={expanded === order.order_id}
                        onToggle={() => setExpanded((current) => (current === order.order_id ? null : order.order_id))}
                        canAct={canAct}
                        showState={filter === 'all' || !!search.trim()}
                        partNames={partNames}
                        busy={pendingIds.has(order.order_id)}
                        onPrint={(body) => orderMutation.mutate({ order, action: 'accept', body })}
                        onSkip={() => orderMutation.mutate({ order, action: 'skip' })}
                        onRestore={() => resetMutation.mutate({ order, restore: true })}
                        onWithdraw={() => setWithdrawing(order)}
                        onRequeue={() => requeueMutation.mutate({ order })}
                        onPlates={() => setPlatesFor(order)}
                        onHave={(line, have) => haveMutation.mutate({ order, line, have })}
                      />
                    ))}
                  </div>
                </section>
                );
              })}
            </div>
          )}
        </>
      )}

      {showSettings && <BaseSettingsModal onClose={() => setShowSettings(false)} onSaved={refresh} />}
      {platesFor && <OrderPlatesModal order={platesFor} canAct={canAct} onClose={() => setPlatesFor(null)} />}
      {withdrawing && (
        <WithdrawOrderModal
          order={withdrawing}
          busy={pendingIds.has(withdrawing.order_id)}

          onConfirm={(returnDone) => orderMutation.mutate({ order: withdrawing, action: 'withdraw', returnDone })}
          onCancel={() => setWithdrawing(null)}
        />
      )}
    </div>
  );
}

function EmptyState(props: {
  filter: Filter;
  source: SourceFilter;
  search: string;
  canSync: boolean;
  onSync: () => void;
  onAllSources: () => void;
  onClearSearch: () => void;
}) {
  const { t } = useTranslation();
  const { filter, source, search, canSync, onSync, onAllSources, onClearSearch } = props;
  let text = t('baseSync.noOrders');
  let action: { label: string; run: () => void } | null = null;
  if (search.trim()) {
    text = t('baseSync.empty.search', { query: search.trim() });
    action = { label: t('baseSync.clearSearch'), run: onClearSearch };
  } else if (source !== 'all') {
    text = t(`baseSync.empty.${source}`);
    action = { label: t('baseSync.empty.allSources'), run: onAllSources };
  } else if (filter === 'new') {
    text = t('baseSync.empty.new');
    if (canSync) action = { label: t('baseSync.syncNow'), run: onSync };
  } else if (filter === 'accepted' || filter === 'ready') {
    text = t(`baseSync.empty.${filter}`);
  }
  return (
    <div className="text-center py-10 text-sm text-bambu-gray">
      <p className="mb-3">{text}</p>
      {action && (
        <Button variant="secondary" className={TOUCH} onClick={action.run}>
          {action.label}
        </Button>
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
