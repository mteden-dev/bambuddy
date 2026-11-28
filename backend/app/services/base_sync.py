"""Orders from Base (base.com, formerly BaseLinker) become product orders (fork).

Read-only: Bambuddy reads orders in the Base statuses chosen ("Przyjęte do
realizacji", and the "ship today / tomorrow / ..." statuses an automation
moves them on to within seconds) and never writes to Base. Every few minutes
the sync:

1. reads the orders in each of those statuses (``getOrders``, 100 a call,
   paged by confirmation time), from the order sources chosen (all by default)
   and confirmed since the date set (by default the moment the sync was set up);
2. keeps each order's Base id, number, source, status, confirmation time,
   ship-by deadline, product lines (SKU, name, quantity) and the buyer's
   marketplace login (Allegro's is a nick, the short name prints are labelled
   with) in ``custom_base_orders`` -- nothing else about the buyer: no name,
   address, phone or email;
3. turns the lines into product orders through the SKU map
   (``custom_product_skus``): a SKU is a product (times ``units``), or a SKU
   nobody prints, or not mapped yet (listed for someone to map). A new order
   waits for someone to send it to production unless orders are accepted
   automatically. Sending it, someone may hold products back (``held``: from
   the shelf, made another way) and say which parts they have already (those
   go into stock as pieces of no known printer, which the planner pairs with
   any printer's). A line can be marked as had already (``have_lines``: made
   by hand, or a product not in Bambuddy yet): nothing is printed for it, and
   a line no product is mapped to keeps an accepted order from ready until it
   is. An accepted order's product orders follow its lines while it stays in
   those statuses (a line added, a quantity changed, a SKU mapped), less what
   was held back and the lines had;
4. cancels the open product orders of an order found in the cancelled status,
   and its done ones too while it was still in those statuses (not packed or
   sent yet): their boxes go back to stock;
5. replans every product whose orders changed (services/products.replan).

Due dates: the marketplace's ship-by deadline (``getOrderTransactionData``'s
``ship_date_to``; for Allegro the end of the dispatch day), read once per order
-- at most ``SHIP_DATE_READS`` orders a pass, the rest the next pass. An order
without one (a shop order) is due ``handling_days`` working days after
confirmation (none for 0).

An order that leaves the statuses without being cancelled is packed: it was
moved on to "to send" or "sent" by hand. Nothing more is printed for it: its
open product orders are done, taking what is in stock for them (that went
into the box; the rest came from elsewhere), and it is listed with the ready
ones. A check that finds its pieces bad does not reopen it.

The token is stored write-only, like the other secrets in settings.
"""

from __future__ import annotations

import asyncio
import json
import logging
import weakref
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.db_dialect import upsert_setting
from backend.app.models.base_sync import BaseOrder, ProductSku
from backend.app.models.products import ProductOrder
from backend.app.models.settings import Settings

if TYPE_CHECKING:
    from backend.app.services.products import PassOutcome

logger = logging.getLogger(__name__)

API_URL = "https://api.base.com/connector.php"
CONFIG_KEY = "base_sync"
TOKEN_KEY = "base_api_token"
EXTERNAL_SOURCE = "base"
PAGE_SIZE = 100
MAX_PAGES = 20
MIN_POLL_MINUTES = 2
MAX_POLL_MINUTES = 24 * 60
# getOrderTransactionData calls a pass (Base allows 100 calls a minute).
SHIP_DATE_READS = 40
REQUEST_TIMEOUT_S = 30


class BaseApiError(RuntimeError):
    """Base answered with an error, or could not be reached."""


@dataclass
class BaseConfig:
    enabled: bool = False
    # Orders are taken from these statuses ("accepted" and the "ship today /
    # tomorrow / ..." ones an automation moves them on to).
    status_ids: list[int] = field(default_factory=list)
    # Orders found here are cancelled in Bambuddy too.
    cancel_status_id: int | None = None
    # "source:id" (e.g. "allegro:1111"); empty for every source.
    sources: list[str] = field(default_factory=list)
    poll_minutes: int = 5
    # New orders go to production at once instead of waiting for someone.
    auto_accept: bool = False
    # Their queue jobs wait for someone to press Start.
    manual_start: bool = False
    # Due date of orders without a ship-by deadline: confirmation + this many
    # working days; 0 for none.
    handling_days: int = 0
    # Only orders confirmed at this moment or later (naive UTC); None for every
    # order Base returns (its last 3 months). Set when the sync is first set up,
    # so orders handled before do not turn up.
    since: datetime | None = None

    def to_json(self) -> dict:
        return {
            "enabled": self.enabled,
            "status_ids": self.status_ids,
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
    raw_statuses = data.get("status_ids")
    if not isinstance(raw_statuses, list):
        # Stored before several statuses: one status_id.
        raw_statuses = [data.get("status_id")]
    status_ids = list(dict.fromkeys(s for s in (opt_int(v) for v in raw_statuses) if s is not None))
    return BaseConfig(
        enabled=bool(data.get("enabled")),
        status_ids=status_ids,
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
    """What the sync keeps of a Base order: of the buyer only the marketplace login."""

    order_id: int
    number: str | None
    source: str | None
    source_id: int | None
    status_id: int | None
    date_confirmed: datetime | None
    lines: tuple[OrderLine, ...]
    # The buyer's login on the marketplace (an Allegro nick); a label, nothing more.
    buyer_login: str | None = None


def parse_order(raw: dict) -> OrderData | None:
    """The fields Bambuddy keeps; the buyer's name, address, phone and email are dropped here."""
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
    when = _timestamp(raw.get("date_confirmed") or raw.get("date_add"))
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
        buyer_login=str(raw.get("user_login") or "").strip()[:100] or None,
    )


def order_label(order: BaseOrder) -> str:
    """The short name a print is labelled with: an Allegro nick, else the shop's order number."""
    if order.source == "allegro" and order.buyer_login:
        return order.buyer_login
    if order.number and len(order.number) <= 12:
        return f"#{order.number}"
    return order.buyer_login or f"#{order.order_id}"


def _timestamp(value) -> datetime | None:
    """A Unix time from Base as naive UTC; None for none or nonsense."""
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).replace(tzinfo=None) if value else None
    except (TypeError, ValueError, OSError, OverflowError):
        return None


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


async def fetch_in_statuses(client: BaseClient, status_ids: list[int], since: datetime | None) -> list[OrderData]:
    """Every confirmed order in any of ``status_ids``; one moved on between two reads counts once."""
    orders: dict[int, OrderData] = {}
    for status_id in status_ids:
        for order in await fetch_orders(client, status_id, since=since):
            orders[order.order_id] = order
    return list(orders.values())


async def fetch_ship_by(client: BaseClient, order_id: int) -> datetime | None:
    """An order's ship-by deadline from its marketplace transaction; None when it has none."""
    body = await client.call("getOrderTransactionData", {"order_id": order_id})
    return _timestamp(body.get("ship_date_to"))


async def fetch_sources(client: BaseClient) -> dict[str, str]:
    """ "source:id" -> the account or shop name, e.g. "allegro:1111" -> "Allegro Shop A"."""
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


def line_key(line: dict) -> str:
    """What tells an order's line apart: its SKU (casefolded), its name when it has none."""
    sku = str(line.get("sku") or "").strip()
    return sku.casefold() if sku else "name:" + str(line.get("name") or "").strip().casefold()


def have_lines(order: BaseOrder) -> set[str]:
    """The keys of the lines someone has already for this order ("I have it")."""
    return {str(key) for key in (order.have_lines or []) if key}


def lines_to_make(order: BaseOrder) -> list[dict]:
    """An order's lines less the ones someone has already: what is made for it."""
    had = have_lines(order)
    return [line for line in order.items or [] if line_key(line) not in had]


def had_lines(order: BaseOrder) -> list[dict]:
    """An order's lines someone has already."""
    had = have_lines(order)
    return [line for line in order.items or [] if line_key(line) in had]


def open_lines(order: BaseOrder, skus: dict[str, SkuTarget]) -> list[dict]:
    """Lines that map to nothing (not even "not printed") and nobody has yet: they keep it from ready."""
    return [line for line in lines_to_make(order) if str(line.get("sku") or "").casefold() not in skus]


def held_products(order: BaseOrder) -> dict[int, int]:
    """product id -> products held back from printing for this order."""
    result = {}
    for key, n in (order.held or {}).items():
        try:
            product_id, count = int(key), int(n)
        except (TypeError, ValueError):
            continue
        if count > 0:
            result[product_id] = count
    return result


def order_due(order: BaseOrder, config: BaseConfig) -> datetime | None:
    """When an order's products are due (naive UTC): its ship-by deadline, else after confirmation."""
    return order.ship_by or _due(order.date_confirmed, config.handling_days)


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


async def reconcile(
    db: AsyncSession,
    order: BaseOrder,
    skus: dict[str, SkuTarget],
    config: BaseConfig,
    *,
    refresh_due: bool = False,
) -> set[int]:
    """Make an accepted order's open product orders match its lines; returns the products changed.

    A product order that is done stays done. One whose line went away (or
    whose SKU was unmapped, or someone has the line already) is cancelled; a
    quantity change follows the line.
    ``refresh_due`` (its ship-by deadline was just read, or ``handling_days``
    changed) sets the open ones' due date again; otherwise a due date set by
    hand stays.
    """
    from backend.app.models.products import Product

    wanted = wanted_products(lines_to_make(order), skus)
    held = held_products(order)
    wanted = {pid: n - held.get(pid, 0) for pid, n in wanted.items()}
    existing_products = set((await db.execute(select(Product.id).where(Product.id.in_(wanted)))).scalars())
    wanted = {pid: n for pid, n in wanted.items() if pid in existing_products and n > 0}
    changed: set[int] = set()
    current = {
        int(po.external_ref.split("/", 1)[1]): po
        for po in await product_orders_of(db, order.order_id)
        if po.external_ref is not None  # always: picked by it
    }
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    due = order_due(order, config)
    for product_id, quantity in wanted.items():
        po = current.get(product_id)
        if po is None:
            db.add(
                ProductOrder(
                    product_id=product_id,
                    quantity=quantity,
                    due_date=due,
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
            if due is not None:
                po.due_date = due
            changed.add(product_id)
        elif po.status == "open":
            if po.quantity != quantity:
                po.quantity = quantity
                changed.add(product_id)
            if refresh_due and due is not None and po.due_date != due:
                po.due_date = due
                changed.add(product_id)
    for product_id, po in current.items():
        if product_id not in wanted and po.status == "open":
            po.status = "cancelled"
            po.completed_at = now
            changed.add(product_id)
    await db.flush()
    return changed


async def cancel_orders_of(db: AsyncSession, order: BaseOrder, *, return_done: bool = False) -> set[int]:
    """Cancel an order's open product orders; returns the products changed.

    ``return_done`` cancels its done ones too, and the pieces they took go back
    to stock: the boxes are still on the shelf (the order was cancelled or
    withdrawn before it left), ready for the next order of the product.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    changed = set()
    for po in await product_orders_of(db, order.order_id):
        if po.status == "open" or (return_done and po.status == "done"):
            po.status = "cancelled"
            po.completed_at = now
            po.consumed = None
            changed.add(po.product_id)
    await db.flush()
    return changed


def is_packed(order: BaseOrder) -> bool:
    """Gone from the statuses orders are taken from, not cancelled: packed (to send, or sent)."""
    return not order.in_status and order.state != "cancelled"


def base_id_of(product_order: ProductOrder) -> int | None:
    """The Base order a product order came from; None for one of another source."""
    if product_order.external_source != EXTERNAL_SOURCE or not product_order.external_ref:
        return None
    try:
        return int(product_order.external_ref.split("/", 1)[0])
    except ValueError:
        return None


async def packed_product_orders(db: AsyncSession, product_orders: list[ProductOrder]) -> set[int]:
    """The ids of the product orders among these whose Base order is packed."""
    base_ids = {po.id: base_id for po in product_orders if (base_id := base_id_of(po)) is not None}
    if not base_ids:
        return set()
    rows = (await db.execute(select(BaseOrder).where(BaseOrder.order_id.in_(set(base_ids.values()))))).scalars()
    packed = {row.order_id for row in rows if is_packed(row)}
    return {po_id for po_id, base_id in base_ids.items() if base_id in packed}


async def close_packed(db: AsyncSession, product_orders: list[ProductOrder]) -> set[int]:
    """Mark these open product orders of packed orders done; returns the products changed.

    Each takes what is in stock for it, ahead of every other order: printed for
    it, it went into the box. Pieces of a product it could not complete count
    too. What is missing came from elsewhere, so nothing more is printed for
    it. The caller replans.
    """
    from backend.app.services import product_planner as planner, products as product_service

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    changed: set[int] = set()
    for po in product_orders:
        if po.status != "open":
            continue
        product = await product_service.load_product(db, po.product_id)
        took: planner.Pool = {}
        if product is not None and product.parts:
            specs = product_service.part_specs(product)
            pool = await product_service.stock_pool(db, product)
            allocation = planner.allocate(specs, pool, [planner.OrderNeed(po.id, max(1, po.quantity))])
            took = {part_id: dict(by_printer) for part_id, by_printer in allocation.taken.get(po.id, {}).items()}
            for spec in specs:
                more = allocation.pieces[po.id][spec.id] - allocation.units[po.id] * spec.per_unit
                holding = allocation.left.get(spec.id, {})
                for printer_id in sorted(holding, key=lambda r: (-holding[r], r)):
                    if more <= 0:
                        break
                    n = min(holding[printer_id], more)
                    if n > 0:
                        planner.pool_add(took, printer_id, ((spec.id, n),))
                        more -= n
        po.status = "done"
        po.completed_at = now
        po.consumed = {
            str(part_id): {str(printer_id): n for printer_id, n in by_printer.items() if n > 0}
            for part_id, by_printer in took.items()
            if any(n > 0 for n in by_printer.values())
        } or None
        changed.add(po.product_id)
    await db.flush()
    return changed


async def close_packed_orders(db: AsyncSession) -> set[int]:
    """Close the open product orders of every packed order (see ``close_packed``)."""
    open_rows = list(
        (
            await db.execute(
                select(ProductOrder).where(
                    ProductOrder.external_source == EXTERNAL_SOURCE, ProductOrder.status == "open"
                )
            )
        ).scalars()
    )
    packed = await packed_product_orders(db, open_rows)
    return await close_packed(db, [po for po in open_rows if po.id in packed])


def unmapped_lines(orders: list[BaseOrder], skus: dict[str, SkuTarget]) -> dict[str, dict]:
    """SKU -> {"name", "orders"} for the lines of waiting or accepted orders (not packed) that map to nothing.

    A line someone has already for its order ("I have it") needs no answer there.
    """
    found: dict[str, dict] = {}
    for order in orders:
        if order.state not in ("new", "accepted") or is_packed(order):
            continue
        for line in lines_to_make(order):
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
    # Left the statuses at this pass without being cancelled.
    packed: int = 0
    replanned: list[int] = field(default_factory=list)
    unmapped: int = 0
    # Products to tell the clients about once committed (``products.PassOutcome.changed_ids``).
    changed_products: list[int] = field(default_factory=list)


@dataclass
class SyncState:
    last_run_at: datetime | None = None
    last_ok_at: datetime | None = None
    last_error: str | None = None
    last_result: SyncResult | None = None


state = SyncState()
_lock = asyncio.Lock()
# One lock per Base order: saves on one order (send, draft, withdraw, take
# back) wait for each other, so each reads what the one before committed.
# ``accept`` writes on hand as a difference from the stored total; two saves
# reading the same total would put the pieces in twice. One backend process.
_order_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = weakref.WeakValueDictionary()


def order_lock(order_id: int) -> asyncio.Lock:
    """The lock of one Base order; hold it from reading the order to the commit."""
    lock = _order_locks.get(order_id)
    if lock is None:
        lock = asyncio.Lock()
        _order_locks[order_id] = lock
    return lock


def _source_key(order: OrderData) -> str:
    return f"{order.source}:{order.source_id or 0}"


# Orders whose ship-by deadline was asked for since the start (one without one,
# a shop order, is not asked again each pass; a restart asks once more).
_ship_checked: set[int] = set()


async def read_ship_dates(client: BaseClient, rows: list[BaseOrder]) -> set[int]:
    """Read the ship-by deadline of orders that lack one; returns the order ids that got one.

    At most ``SHIP_DATE_READS`` a pass, oldest first; the rest wait for the next pass.
    """
    waiting = [
        r for r in rows if r.ship_by is None and r.state in ("new", "accepted") and r.order_id not in _ship_checked
    ]
    waiting.sort(key=lambda r: (r.date_confirmed or datetime.max, r.order_id))
    dated = set()
    for row in waiting[:SHIP_DATE_READS]:
        try:
            ship_by = await fetch_ship_by(client, row.order_id)
        except BaseApiError as exc:
            logger.warning("[BASE] No ship-by date for order %s: %s", row.order_id, exc)
            ship_by = None
        _ship_checked.add(row.order_id)
        if ship_by is not None:
            row.ship_by = ship_by
            dated.add(row.order_id)
    return dated


async def replan_products(db: AsyncSession, product_ids: set[int], config: BaseConfig) -> PassOutcome | None:
    """Plan each product again, as the system (all printers); None when there are none. The caller commits.

    One pass, the most urgent first, with the products behind them in the
    queue planned again too (see ``products.replan_pass``).
    """
    from backend.app.services import products as product_service

    if not product_ids:
        return None
    return await product_service.replan_pass(
        db, product_ids, actor_id=None, manual_start=config.manual_start, printer_ids=None
    )


async def sync(db: AsyncSession, client: BaseClient | None = None) -> SyncResult:
    """One pass (see the module docstring). The caller commits."""
    config = await read_config(db)
    if not config.status_ids:
        raise BaseApiError("Choose the Base statuses orders are taken from")
    if client is None:
        token = await read_token(db)
        if not token:
            raise BaseApiError("Enter the Base API token")
        client = BaseClient(token)

    fetched = await fetch_in_statuses(client, config.status_ids, since=config.since)
    if config.sources:
        allowed = set(config.sources)
        fetched = [o for o in fetched if _source_key(o) in allowed]
    names = await fetch_sources(client)
    skus = await sku_map(db)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    result = SyncResult(seen=len(fetched))
    changed: set[int] = set()

    tracked = {row.order_id: row for row in (await db.execute(select(BaseOrder))).scalars()}
    # Still in the statuses at the last pass: not moved on (packed, sent) by hand.
    was_in_status = {order_id: bool(row.in_status) for order_id, row in tracked.items()}
    seen_ids = set()
    seen_rows: list[BaseOrder] = []
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
        row.buyer_login = data.buyer_login
        row.source = data.source
        row.source_id = data.source_id
        row.source_name = names.get(_source_key(data)) or row.source_name
        row.status_id = data.status_id
        row.date_confirmed = data.date_confirmed
        row.items = items
        row.in_status = True
        row.last_seen_at = now
        seen_rows.append(row)

    dated = await read_ship_dates(client, seen_rows)
    for row in seen_rows:
        if row.state == "accepted":
            changed |= await reconcile(db, row, skus, config, refresh_due=row.order_id in dated)

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
                    # Cancelled before it left: what was printed for it is on the shelf.
                    changed |= await cancel_orders_of(db, row, return_done=was_in_status.get(row.order_id, False))
                    result.cancelled += 1

    await db.flush()
    # Gone from the statuses and not cancelled: packed, nothing more to print for it.
    result.packed = sum(1 for order_id, row in tracked.items() if was_in_status.get(order_id) and is_packed(row))
    changed |= await close_packed_orders(db)
    result.unmapped = len(unmapped_lines(list(tracked.values()), skus))
    if changed:
        done = await replan_products(db, changed, config)
        result.replanned = sorted(changed)
        result.changed_products = done.changed_ids if done is not None else []
    return result


@dataclass(frozen=True)
class ProductChoice:
    """What to print of one product of an order, chosen line by line."""

    product_id: int
    # Products to print; the rest of what the lines want is held back.
    units: int
    # part id -> pieces on hand for this order, outside the stock Bambuddy
    # counted before; the whole set for the product (a part left out is 0).
    have: dict[int, int] = field(default_factory=dict)


def on_hand_parts(order: BaseOrder) -> dict[int, int]:
    """part id -> pieces on hand that were put into stock for this order."""
    result = {}
    for key, n in (order.on_hand or {}).items():
        try:
            part_id, count = int(key), int(n)
        except (TypeError, ValueError):
            continue
        if count > 0:
            result[part_id] = count
    return result


def _adjust_on_hand(db: AsyncSession, order: BaseOrder, part_id: int, delta: int) -> None:
    from backend.app.models.products import ProductStockAdjustment

    if delta:
        db.add(
            ProductStockAdjustment(
                part_id=part_id,
                printer_id=None,
                delta=delta,
                note=f"{_label(order)}: on hand"[:255],
            )
        )


async def _part_products(db: AsyncSession, part_ids: set[int]) -> dict[int, int]:
    from backend.app.models.products import ProductPart

    if not part_ids:
        return {}
    rows = await db.execute(select(ProductPart.id, ProductPart.product_id).where(ProductPart.id.in_(part_ids)))
    return dict(rows.all())


def draft_parts(order: BaseOrder) -> tuple[dict[int, int], dict[int, int]]:
    """A waiting order's saved choice: (product id -> held back, part id -> on hand)."""

    def ints(raw) -> dict[int, int]:
        result = {}
        for key, n in (raw or {}).items():
            try:
                k, v = int(key), int(n)
            except (TypeError, ValueError):
                continue
            if v > 0:
                result[k] = v
        return result

    draft = order.draft or {}
    return ints(draft.get("held")), ints(draft.get("on_hand"))


async def _check_choices(db: AsyncSession, order: BaseOrder, choices: list[ProductChoice], skus) -> dict[int, set[int]]:
    """Every choice names a product of the order and parts of that product; returns product -> its parts."""
    from backend.app.models.products import ProductPart

    wanted = wanted_products(lines_to_make(order), skus)
    parts: dict[int, set[int]] = {}
    for choice in choices:
        if choice.product_id not in wanted:
            raise ValueError(f"The order has no line for product {choice.product_id}")
        parts[choice.product_id] = {
            part.id
            for part in (
                await db.execute(select(ProductPart).where(ProductPart.product_id == choice.product_id))
            ).scalars()
        }
        for part_id in choice.have:
            if part_id not in parts[choice.product_id]:
                raise ValueError(f"Part {part_id} is not a part of product {choice.product_id}")
    return parts


async def save_draft(db: AsyncSession, order: BaseOrder, choices: list[ProductChoice]) -> None:
    """Keep a choice on a waiting order without sending it: nothing goes into stock or the queue.

    The choices replace the saved ones for their products; sending the order
    applies them. The caller commits.
    """
    skus = await sku_map(db)
    await _check_choices(db, order, choices, skus)
    wanted = wanted_products(lines_to_make(order), skus)
    held, on_hand = draft_parts(order)
    owner = await _part_products(db, set(on_hand))
    for choice in choices:
        held[choice.product_id] = max(0, wanted[choice.product_id] - max(0, choice.units))
        for part_id in [p for p, product_id in owner.items() if product_id == choice.product_id]:
            on_hand.pop(part_id, None)
        for part_id, pieces in choice.have.items():
            if pieces > 0:
                on_hand[part_id] = pieces
    held = {pid: n for pid, n in held.items() if n > 0}
    order.draft = (
        {"held": {str(k): v for k, v in held.items()}, "on_hand": {str(k): v for k, v in on_hand.items()}}
        if held or on_hand
        else None
    )
    await db.flush()


async def _draft_choices(db: AsyncSession, order: BaseOrder, skus) -> list[ProductChoice] | None:
    """The saved choice as choices for every product of the order; None without one."""
    if not order.draft:
        return None
    held, on_hand = draft_parts(order)
    owner = await _part_products(db, set(on_hand))
    wanted = wanted_products(lines_to_make(order), skus)
    return [
        ProductChoice(
            product_id,
            max(0, units - held.get(product_id, 0)),
            {part_id: n for part_id, n in on_hand.items() if owner.get(part_id) == product_id},
        )
        for product_id, units in wanted.items()
    ]


async def accept(db: AsyncSession, order: BaseOrder, choices: list[ProductChoice] | None = None) -> set[int]:
    """Send an order to production (or change what it prints); returns the products changed.

    Without choices the choice saved while it waited (``draft``) is sent, or
    every mapped line in full when there is none. A choice holds back
    the products it does not print and says which parts are on hand for the
    order: they are in stock as pieces of no known printer (a correction noted
    with the order). On hand is a total: changing it later puts in or takes
    out only the difference, so saving twice never counts a piece twice. The
    caller replans and commits.
    """
    from backend.app.models.products import ProductPart

    config = await read_config(db)
    skus = await sku_map(db)
    changed: set[int] = set()
    if choices is None:
        # A choice saved while it waited is what is sent.
        choices = await _draft_choices(db, order, skus)
    order.draft = None
    if choices is not None:
        wanted = wanted_products(lines_to_make(order), skus)
        held = held_products(order)
        on_hand = on_hand_parts(order)
        owner = await _part_products(db, set(on_hand))
        for choice in choices:
            if choice.product_id not in wanted:
                raise ValueError(f"The order has no line for product {choice.product_id}")
            held[choice.product_id] = max(0, wanted[choice.product_id] - max(0, choice.units))
            parts = {
                part.id
                for part in (
                    await db.execute(select(ProductPart).where(ProductPart.product_id == choice.product_id))
                ).scalars()
            }
            for part_id in choice.have:
                if part_id not in parts:
                    raise ValueError(f"Part {part_id} is not a part of product {choice.product_id}")
            for part_id in parts | {p for p, product_id in owner.items() if product_id == choice.product_id}:
                before = on_hand.get(part_id, 0)
                after = max(0, choice.have.get(part_id, 0))
                if after != before:
                    _adjust_on_hand(db, order, part_id, after - before)
                    changed.add(choice.product_id)
                if after:
                    on_hand[part_id] = after
                else:
                    on_hand.pop(part_id, None)
        order.held = {str(pid): n for pid, n in held.items() if n > 0} or None
        order.on_hand = {str(pid): n for pid, n in on_hand.items() if n > 0} or None
    order.state = "accepted"
    changed |= await reconcile(db, order, skus, config)
    return changed


async def set_have(db: AsyncSession, order: BaseOrder, key: str, have: bool) -> set[int]:
    """Say someone has a line of the order already ("I have it"), or no more; returns the products changed.

    Nothing is printed for a line someone has, whatever its SKU maps to: an
    accepted order's product orders follow at once. A waiting order keeps it
    until it is sent, and sending it, taking that back or skipping it leaves it
    as it is: it is about the thing on the shelf, not the order's printing.
    The caller replans and commits.
    """
    if not any(line_key(line) == key for line in order.items or []):
        raise ValueError("The order has no such line")
    had = have_lines(order)
    if have:
        had.add(key)
    else:
        had.discard(key)
    order.have_lines = sorted(had) or None
    await db.flush()
    if order.state != "accepted":
        return set()
    return await reconcile(db, order, await sku_map(db), await read_config(db))


async def reset(db: AsyncSession, order: BaseOrder) -> set[int]:
    """Take a decision back: the order waits again, as it came from Base; returns the products changed.

    Its product orders are cancelled (done ones give their pieces back to
    stock: it is undone), what was held back is forgotten and the pieces put
    into stock as on hand for it are taken out again. The caller replans and
    commits.
    """
    changed = await cancel_orders_of(db, order, return_done=True)
    on_hand = on_hand_parts(order)
    owner = await _part_products(db, set(on_hand))
    for part_id, pieces in on_hand.items():
        _adjust_on_hand(db, order, part_id, -pieces)
        if part_id in owner:
            changed.add(owner[part_id])
    order.on_hand = None
    order.held = None
    order.draft = None
    order.state = "new"
    await db.flush()
    return changed


async def skip(db: AsyncSession, order: BaseOrder, *, return_done: bool = False) -> set[int]:
    """Leave an order out (withdraw it); its open product orders are cancelled.

    ``return_done``: its done ones too, their boxes back in stock. The caller
    replans and commits.
    """
    order.state = "skipped"
    return await cancel_orders_of(db, order, return_done=return_done)


async def refresh_accepted(db: AsyncSession, sku: str | None = None, *, refresh_due: bool = False) -> set[int]:
    """Reconcile accepted orders still in the statuses (after the SKU map or the due settings changed)."""
    config = await read_config(db)
    skus = await sku_map(db)
    rows = (
        await db.execute(select(BaseOrder).where(BaseOrder.state == "accepted", BaseOrder.in_status.is_(True)))
    ).scalars()
    changed: set[int] = set()
    for row in rows:
        if sku is None or any(str(line.get("sku") or "").casefold() == sku.casefold() for line in row.items or []):
            changed |= await reconcile(db, row, skus, config, refresh_due=refresh_due)
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
            from backend.app.services.products import announce_replanned

            await announce_replanned(result.changed_products)
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
            if config.enabled and token and config.status_ids and due:
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
