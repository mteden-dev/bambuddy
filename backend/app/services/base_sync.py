"""Orders from Base (base.com, formerly BaseLinker) become product orders (fork).

Read-only: Bambuddy reads orders in one Base status ("Przyjęte do
realizacji", say) and never writes to Base. Every few minutes the sync:

1. reads the orders in that status (``getOrders``, 100 a call, paged by
   confirmation time), from the order sources chosen (all by default) and
   confirmed since the date set (by default the moment the sync was set up);
2. keeps each order's Base id, number, source, confirmation time and product
   lines (SKU, name, quantity) in ``custom_base_orders`` -- nothing about the
   buyer;
3. turns the lines into product orders through the SKU map
   (``custom_product_skus``): a SKU is a product (times ``units``), or a SKU
   nobody prints, or not mapped yet (listed for someone to map). A new order
   waits for someone to send it to production unless orders are accepted
   automatically; an accepted order's product orders follow its lines while
   it stays in the status (a line added, a quantity changed, a SKU mapped);
4. cancels the open product orders of an order found in the cancelled status;
5. replans every product whose orders changed (services/products.replan).

An order that leaves the status (moved on by hand) keeps its product orders:
moving it to "W produkcji" in Base must not stop its prints.

The token is stored write-only, like the other secrets in settings.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.db_dialect import upsert_setting
from backend.app.models.base_sync import BaseOrder, ProductSku
from backend.app.models.products import ProductOrder
from backend.app.models.settings import Settings

logger = logging.getLogger(__name__)

API_URL = "https://api.base.com/connector.php"
CONFIG_KEY = "base_sync"
TOKEN_KEY = "base_api_token"
EXTERNAL_SOURCE = "base"
PAGE_SIZE = 100
MAX_PAGES = 20
MIN_POLL_MINUTES = 2
MAX_POLL_MINUTES = 24 * 60
REQUEST_TIMEOUT_S = 30


class BaseApiError(RuntimeError):
    """Base answered with an error, or could not be reached."""


@dataclass
class BaseConfig:
    enabled: bool = False
    # Orders are taken from this status.
    status_id: int | None = None
    # Orders found here are cancelled in Bambuddy too.
    cancel_status_id: int | None = None
    # "source:id" (e.g. "allegro:7697"); empty for every source.
    sources: list[str] = field(default_factory=list)
    poll_minutes: int = 5
    # New orders go to production at once instead of waiting for someone.
    auto_accept: bool = False
    # Their queue jobs wait for someone to press Start.
    manual_start: bool = False
    # Due date: confirmation + this many working days; 0 for none.
    handling_days: int = 0
    # Only orders confirmed at this moment or later (naive UTC); None for every
    # order Base returns (its last 3 months). Set when the sync is first set up,
    # so orders handled before do not turn up.
    since: datetime | None = None

    def to_json(self) -> dict:
        return {
            "enabled": self.enabled,
            "status_id": self.status_id,
            "cancel_status_id": self.cancel_status_id,
            "sources": self.sources,
            "poll_minutes": self.poll_minutes,
            "auto_accept": self.auto_accept,
            "manual_start": self.manual_start,
            "handling_days": self.handling_days,
            "since": self.since.isoformat() if self.since else None,
        }


def parse_config(raw: str | None) -> BaseConfig:
    try:
        data = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}

    def opt_int(value) -> int | None:
        try:
            return int(value) if value not in (None, "") else None
        except (TypeError, ValueError):
            return None

    sources = data.get("sources") or []
    return BaseConfig(
        enabled=bool(data.get("enabled")),
        status_id=opt_int(data.get("status_id")),
        cancel_status_id=opt_int(data.get("cancel_status_id")),
        sources=[str(s) for s in sources if isinstance(s, (str, int))] if isinstance(sources, list) else [],
        poll_minutes=max(MIN_POLL_MINUTES, min(MAX_POLL_MINUTES, opt_int(data.get("poll_minutes")) or 5)),
        auto_accept=bool(data.get("auto_accept")),
        manual_start=bool(data.get("manual_start")),
        handling_days=max(0, min(60, opt_int(data.get("handling_days")) or 0)),
        since=_parse_time(data.get("since")),
    )


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed


async def read_config(db: AsyncSession) -> BaseConfig:
    raw = (await db.execute(select(Settings.value).where(Settings.key == CONFIG_KEY))).scalar()
    return parse_config(raw)


async def write_config(db: AsyncSession, config: BaseConfig) -> None:
    """Store it. The caller commits."""
    await upsert_setting(db, Settings, CONFIG_KEY, json.dumps(config.to_json(), separators=(",", ":")))


async def read_token(db: AsyncSession) -> str | None:
    value = (await db.execute(select(Settings.value).where(Settings.key == TOKEN_KEY))).scalar()
    return value or None


async def write_token(db: AsyncSession, token: str | None) -> None:
    """Store or clear it. The caller commits."""
    await upsert_setting(db, Settings, TOKEN_KEY, (token or "").strip())


# --- the API -----------------------------------------------------------------------------


class BaseClient:
    """Base's API: one POST per method, the token in a header."""

    def __init__(self, token: str, url: str = API_URL):
        self._token = token
        self._url = url

    async def call(self, method: str, parameters: dict | None = None) -> dict:
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S) as client:
                response = await client.post(
                    self._url,
                    headers={"X-BLToken": self._token},
                    data={"method": method, "parameters": json.dumps(parameters or {})},
                )
        except httpx.HTTPError as exc:
            raise BaseApiError(f"Base could not be reached: {exc.__class__.__name__}") from exc
        if response.status_code != 200:
            raise BaseApiError(f"Base answered HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise BaseApiError("Base sent an answer that is not JSON") from exc
        if body.get("status") != "SUCCESS":
            code = body.get("error_code") or "ERROR"
            raise BaseApiError(f"{code}: {body.get('error_message') or 'Base refused the request'}")
        return body


@dataclass(frozen=True)
class OrderLine:
    sku: str
    name: str
    quantity: int
    attributes: str = ""


@dataclass(frozen=True)
class OrderData:
    """What the sync keeps of a Base order: no buyer data."""

    order_id: int
    number: str | None
    source: str | None
    source_id: int | None
    status_id: int | None
    date_confirmed: datetime | None
    lines: tuple[OrderLine, ...]


def parse_order(raw: dict) -> OrderData | None:
    """The fields Bambuddy keeps; buyer, address, phone and email are dropped here."""
    try:
        order_id = int(raw["order_id"])
    except (KeyError, TypeError, ValueError):
        return None
    lines = []
    for product in raw.get("products") or []:
        if not isinstance(product, dict):
            continue
        try:
            quantity = int(product.get("quantity") or 0)
        except (TypeError, ValueError):
            quantity = 0
        sku = str(product.get("sku") or "").strip()
        if quantity <= 0:
            continue
        lines.append(
            OrderLine(
                sku=sku,
                name=str(product.get("name") or "")[:255],
                quantity=quantity,
                attributes=str(product.get("attributes") or "")[:255],
            )
        )
    number = raw.get("shop_order_id") or raw.get("external_order_id") or None
    confirmed = raw.get("date_confirmed") or raw.get("date_add")
    try:
        when = datetime.fromtimestamp(int(confirmed), tz=timezone.utc).replace(tzinfo=None) if confirmed else None
    except (TypeError, ValueError, OSError):
        when = None
    try:
        source_id = int(raw["order_source_id"]) if raw.get("order_source_id") not in (None, "") else None
    except (TypeError, ValueError):
        source_id = None
    try:
        status_id = int(raw["order_status_id"]) if raw.get("order_status_id") not in (None, "") else None
    except (TypeError, ValueError):
        status_id = None
    return OrderData(
        order_id=order_id,
        number=str(number) if number not in (None, "", 0) else None,
        source=str(raw.get("order_source") or "") or None,
        source_id=source_id,
        status_id=status_id,
        date_confirmed=when,
        lines=tuple(lines),
    )


async def fetch_orders(client: BaseClient, status_id: int, since: datetime | None = None) -> list[OrderData]:
    """Every confirmed order in ``status_id`` (confirmed at ``since`` or later), page by page."""
    orders: dict[int, OrderData] = {}
    parameters: dict = {"status_id": status_id, "get_unconfirmed_orders": False}
    if since is not None:
        parameters["date_confirmed_from"] = int(since.replace(tzinfo=timezone.utc).timestamp())
    for _ in range(MAX_PAGES):
        body = await client.call("getOrders", parameters)
        page = body.get("orders") or []
        latest = None
        for raw in page:
            order = parse_order(raw)
            if order is not None:
                orders[order.order_id] = order
            try:
                confirmed = int(raw.get("date_confirmed") or 0)
            except (TypeError, ValueError):
                confirmed = 0
            latest = max(latest or 0, confirmed)
        if len(page) < PAGE_SIZE or not latest:
            break
        parameters = {**parameters, "date_confirmed_from": latest + 1}
    return list(orders.values())


async def fetch_sources(client: BaseClient) -> dict[str, str]:
    """ "source:id" -> the account or shop name, e.g. "allegro:7697" -> "MTEPrints"."""
    body = await client.call("getOrderSources", {})
    names: dict[str, str] = {}
    for source, entries in (body.get("sources") or {}).items():
        if isinstance(entries, dict):
            for source_id, name in entries.items():
                names[f"{source}:{source_id}"] = str(name)
        elif isinstance(entries, list):
            for name in entries:
                names[f"{source}:0"] = str(name)
    return names


async def fetch_statuses(client: BaseClient) -> list[dict]:
    body = await client.call("getOrderStatusList", {})
    return [
        {"id": int(s["id"]), "name": str(s.get("name") or s["id"]), "color": s.get("color")}
        for s in body.get("statuses") or []
        if isinstance(s, dict) and s.get("id") is not None
    ]


# --- SKUs and product orders -------------------------------------------------------------


@dataclass(frozen=True)
class SkuTarget:
    product_id: int | None  # None: not printed
    units: int


async def sku_map(db: AsyncSession) -> dict[str, SkuTarget]:
    rows = (await db.execute(select(ProductSku))).scalars()
    return {row.sku.casefold(): SkuTarget(row.product_id, max(1, row.units or 1)) for row in rows}


def wanted_products(lines: list[dict], skus: dict[str, SkuTarget]) -> dict[int, int]:
    """product id -> products an order's lines want (mapped SKUs only)."""
    wanted: dict[int, int] = {}
    for line in lines:
        target = skus.get(str(line.get("sku") or "").casefold())
        if target is None or target.product_id is None:
            continue
        wanted[target.product_id] = wanted.get(target.product_id, 0) + int(line.get("quantity") or 0) * target.units
    return wanted


def _due(confirmed: datetime | None, working_days: int) -> datetime | None:
    if not confirmed or working_days <= 0:
        return None
    due = confirmed
    left = working_days
    while left > 0:
        due += timedelta(days=1)
        if due.weekday() < 5:
            left -= 1
    return due


def _ref(order_id: int, product_id: int) -> str:
    return f"{order_id}/{product_id}"


async def product_orders_of(db: AsyncSession, order_id: int) -> list[ProductOrder]:
    rows = (
        await db.execute(
            select(ProductOrder).where(
                ProductOrder.external_source == EXTERNAL_SOURCE,
                ProductOrder.external_ref.like(f"{order_id}/%"),
            )
        )
    ).scalars()
    return list(rows)


def _label(order: BaseOrder) -> str:
    where = order.source_name or order.source or "Base"
    return f"Base #{order.number or order.order_id} ({where})"


async def reconcile(db: AsyncSession, order: BaseOrder, skus: dict[str, SkuTarget], config: BaseConfig) -> set[int]:
    """Make an accepted order's open product orders match its lines; returns the products changed.

    A product order that is done stays done. One whose line went away (or
    whose SKU was unmapped) is cancelled; a quantity change follows the line.
    """
    from backend.app.models.products import Product

    wanted = wanted_products(order.items or [], skus)
    existing_products = set((await db.execute(select(Product.id).where(Product.id.in_(wanted)))).scalars())
    wanted = {pid: n for pid, n in wanted.items() if pid in existing_products and n > 0}
    changed: set[int] = set()
    current = {int(po.external_ref.split("/", 1)[1]): po for po in await product_orders_of(db, order.order_id)}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for product_id, quantity in wanted.items():
        po = current.get(product_id)
        if po is None:
            db.add(
                ProductOrder(
                    product_id=product_id,
                    quantity=quantity,
                    due_date=_due(order.date_confirmed, config.handling_days),
                    notes=_label(order),
                    status="open",
                    external_source=EXTERNAL_SOURCE,
                    external_ref=_ref(order.order_id, product_id),
                    created_at=order.date_confirmed or now,
                )
            )
            changed.add(product_id)
        elif po.status == "cancelled":
            po.status = "open"
            po.completed_at = None
            po.quantity = quantity
            changed.add(product_id)
        elif po.status == "open" and po.quantity != quantity:
            po.quantity = quantity
            changed.add(product_id)
    for product_id, po in current.items():
        if product_id not in wanted and po.status == "open":
            po.status = "cancelled"
            po.completed_at = now
            changed.add(product_id)
    await db.flush()
    return changed


async def cancel_orders_of(db: AsyncSession, order: BaseOrder) -> set[int]:
    """Cancel an order's open product orders; returns the products changed."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    changed = set()
    for po in await product_orders_of(db, order.order_id):
        if po.status == "open":
            po.status = "cancelled"
            po.completed_at = now
            changed.add(po.product_id)
    await db.flush()
    return changed


def unmapped_lines(orders: list[BaseOrder], skus: dict[str, SkuTarget]) -> dict[str, dict]:
    """SKU -> {"name", "orders"} for the lines of waiting or accepted orders that map to nothing."""
    found: dict[str, dict] = {}
    for order in orders:
        if order.state not in ("new", "accepted"):
            continue
        for line in order.items or []:
            sku = str(line.get("sku") or "")
            if not sku or sku.casefold() in skus:
                continue
            entry = found.setdefault(sku, {"name": line.get("name") or "", "orders": set()})
            entry["orders"].add(order.order_id)
    return {sku: {"name": e["name"], "orders": len(e["orders"])} for sku, e in found.items()}


# --- the sync -----------------------------------------------------------------------------


@dataclass
class SyncResult:
    seen: int = 0
    new: int = 0
    updated: int = 0
    cancelled: int = 0
    replanned: list[int] = field(default_factory=list)
    unmapped: int = 0


@dataclass
class SyncState:
    last_run_at: datetime | None = None
    last_ok_at: datetime | None = None
    last_error: str | None = None
    last_result: SyncResult | None = None


state = SyncState()
_lock = asyncio.Lock()


def _source_key(order: OrderData) -> str:
    return f"{order.source}:{order.source_id or 0}"


async def replan_products(db: AsyncSession, product_ids: set[int], config: BaseConfig) -> list[int]:
    """Plan each product again, as the system (all printers). The caller commits."""
    from backend.app.services import products as product_service

    done = []
    for product_id in sorted(product_ids):
        await product_service.replan(db, product_id, actor_id=None, manual_start=config.manual_start, printer_ids=None)
        done.append(product_id)
    return done


async def sync(db: AsyncSession, client: BaseClient | None = None) -> SyncResult:
    """One pass (see the module docstring). The caller commits."""
    config = await read_config(db)
    if config.status_id is None:
        raise BaseApiError("Choose the Base status orders are taken from")
    if client is None:
        token = await read_token(db)
        if not token:
            raise BaseApiError("Enter the Base API token")
        client = BaseClient(token)

    fetched = await fetch_orders(client, config.status_id, since=config.since)
    if config.sources:
        allowed = set(config.sources)
        fetched = [o for o in fetched if _source_key(o) in allowed]
    names = await fetch_sources(client)
    skus = await sku_map(db)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    result = SyncResult(seen=len(fetched))
    changed: set[int] = set()

    tracked = {row.order_id: row for row in (await db.execute(select(BaseOrder))).scalars()}
    seen_ids = set()
    for data in fetched:
        seen_ids.add(data.order_id)
        items = [
            {"sku": line.sku, "name": line.name, "quantity": line.quantity, "attributes": line.attributes}
            for line in data.lines
        ]
        row = tracked.get(data.order_id)
        if row is None:
            row = BaseOrder(
                order_id=data.order_id,
                state="accepted" if config.auto_accept else "new",
                first_seen_at=now,
            )
            db.add(row)
            tracked[data.order_id] = row
            result.new += 1
        elif row.items != items:
            result.updated += 1
        row.number = data.number
        row.source = data.source
        row.source_id = data.source_id
        row.source_name = names.get(_source_key(data)) or row.source_name
        row.status_id = data.status_id
        row.date_confirmed = data.date_confirmed
        row.items = items
        row.in_status = True
        row.last_seen_at = now
        if row.state == "accepted":
            changed |= await reconcile(db, row, skus, config)

    for order_id, row in tracked.items():
        # One confirmed before ``since`` is not asked for any more: not seen is no news.
        older = config.since is not None and row.date_confirmed is not None and row.date_confirmed < config.since
        if order_id not in seen_ids and row.in_status and not older:
            row.in_status = False

    if config.cancel_status_id is not None:
        open_rows = [r for r in tracked.values() if r.state in ("new", "accepted") and r.order_id not in seen_ids]
        if open_rows:
            oldest = min((r.date_confirmed for r in open_rows if r.date_confirmed), default=None)
            cancelled = await fetch_orders(client, config.cancel_status_id, since=oldest)
            for data in cancelled:
                row = tracked.get(data.order_id)
                if row is not None and row.state in ("new", "accepted"):
                    row.state = "cancelled"
                    row.status_id = data.status_id
                    changed |= await cancel_orders_of(db, row)
                    result.cancelled += 1

    await db.flush()
    result.unmapped = len(unmapped_lines(list(tracked.values()), skus))
    if changed:
        result.replanned = await replan_products(db, changed, config)
    return result


async def accept(db: AsyncSession, order: BaseOrder) -> set[int]:
    """Send an order to production. The caller replans and commits."""
    config = await read_config(db)
    order.state = "accepted"
    return await reconcile(db, order, await sku_map(db), config)


async def skip(db: AsyncSession, order: BaseOrder) -> set[int]:
    """Leave an order out; its open product orders are cancelled. The caller replans and commits."""
    order.state = "skipped"
    return await cancel_orders_of(db, order)


async def refresh_accepted(db: AsyncSession, sku: str | None = None) -> set[int]:
    """Reconcile accepted orders still in the status (after the SKU map changed)."""
    config = await read_config(db)
    skus = await sku_map(db)
    rows = (
        await db.execute(select(BaseOrder).where(BaseOrder.state == "accepted", BaseOrder.in_status.is_(True)))
    ).scalars()
    changed: set[int] = set()
    for row in rows:
        if sku is None or any(str(line.get("sku") or "").casefold() == sku.casefold() for line in row.items or []):
            changed |= await reconcile(db, row, skus, config)
    return changed


async def run_once() -> SyncResult | None:
    """A sync in its own session, recorded in ``state``; None when it is off."""
    from backend.app.core import database

    async with _lock:
        state.last_run_at = datetime.now(timezone.utc)
        try:
            async with database.async_session() as db:
                result = await sync(db)
                await db.commit()
            if result.replanned:
                logger.info("[BASE] Replanned products %s", result.replanned)
            state.last_ok_at = state.last_run_at
            state.last_error = None
            state.last_result = result
            return result
        except BaseApiError as exc:
            state.last_error = str(exc)
            logger.warning("[BASE] Sync failed: %s", exc)
            raise
        except Exception as exc:
            state.last_error = f"{exc.__class__.__name__}: {exc}"
            logger.exception("[BASE] Sync failed")
            raise


# --- the loop -----------------------------------------------------------------------------

_task: asyncio.Task | None = None
CHECK_EVERY_S = 60


async def _loop() -> None:
    from backend.app.core import database

    while True:
        try:
            async with database.async_session() as db:
                config = await read_config(db)
                token = await read_token(db)
            due = state.last_run_at is None or datetime.now(timezone.utc) - state.last_run_at >= timedelta(
                minutes=config.poll_minutes
            )
            if config.enabled and token and config.status_id is not None and due:
                try:
                    await run_once()
                except Exception:  # recorded in state; the loop goes on
                    pass
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[BASE] Sync loop error")
        await asyncio.sleep(CHECK_EVERY_S)


def start() -> None:
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
