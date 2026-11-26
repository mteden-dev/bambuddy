"""Orders from Base (base.com) for products: settings, the sync, orders, SKUs (fork).

How it works is in services/base_sync.py. Read-only towards Base.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import RequirePermissionIfAuthEnabled, require_ownership_permission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.base_sync import BaseOrder, ProductSku
from backend.app.models.products import Product, ProductOrder
from backend.app.models.user import User
from backend.app.schemas.not_null import IgnoresNullForRequiredColumns
from backend.app.schemas.print_queue import NaiveUTCDatetime, UTCDatetime
from backend.app.services import base_sync as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/base-sync", tags=["base-sync"])

ReadAccess = Depends(require_ownership_permission(Permission.QUEUE_READ_ALL, Permission.QUEUE_READ_OWN))


def _utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


# --- settings ------------------------------------------------------------------------------


class BaseSettingsIn(IgnoresNullForRequiredColumns):
    # One settings row; a null counts as not sent.
    __orm_table__ = "settings"

    enabled: bool | None = None
    # Statuses orders are taken from, e.g. "accepted" and the "ship today / tomorrow" ones.
    status_ids: list[int] | None = Field(None, max_length=50)
    cancel_status_id: int | None = None
    clear_cancel_status: bool = False
    sources: list[str] | None = Field(None, max_length=100)
    poll_minutes: int | None = Field(None, ge=svc.MIN_POLL_MINUTES, le=svc.MAX_POLL_MINUTES)
    auto_accept: bool | None = None
    manual_start: bool | None = None
    handling_days: int | None = Field(None, ge=0, le=60)
    # Only orders confirmed from then on; clear_since takes every order (3 months).
    since: NaiveUTCDatetime = None
    clear_since: bool = False
    # Write-only: omitted keeps it, "" clears it.
    api_token: str | None = Field(None, max_length=200)


class BaseSettingsOut(BaseModel):
    enabled: bool
    status_ids: list[int]
    cancel_status_id: int | None
    sources: list[str]
    poll_minutes: int
    auto_accept: bool
    manual_start: bool
    handling_days: int
    since: UTCDatetime = None
    token_set: bool
    last_run_at: UTCDatetime = None
    last_ok_at: UTCDatetime = None
    last_error: str | None = None


async def _settings_out(db: AsyncSession) -> BaseSettingsOut:
    config = await svc.read_config(db)
    return BaseSettingsOut(
        **{**config.to_json(), "since": config.since},
        token_set=bool(await svc.read_token(db)),
        last_run_at=_utc(svc.state.last_run_at),
        last_ok_at=_utc(svc.state.last_ok_at),
        last_error=svc.state.last_error,
    )


@router.get("/settings", response_model=BaseSettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    return await _settings_out(db)


@router.put("/settings", response_model=BaseSettingsOut)
async def put_settings(
    data: BaseSettingsIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Change the sync's settings; the token is write-only (``token_set`` says if one is stored).

    Choosing statuses for the first time without a date sets ``since`` to now:
    orders already in them before are not taken. ``clear_since`` takes every
    order Base returns instead (its last 3 months). A change to
    ``handling_days`` sets the due dates of accepted orders without a ship-by
    deadline again.
    """
    config = await svc.read_config(db)
    first_setup = not config.status_ids
    handling_days = config.handling_days
    sent = data.model_fields_set
    for name in ("enabled", "poll_minutes", "auto_accept", "manual_start", "handling_days"):
        value = getattr(data, name)
        if name in sent and value is not None:
            setattr(config, name, value)
    if "status_ids" in sent and data.status_ids is not None:
        config.status_ids = list(dict.fromkeys(data.status_ids))
    if data.clear_cancel_status:
        config.cancel_status_id = None
    elif "cancel_status_id" in sent and data.cancel_status_id is not None:
        config.cancel_status_id = data.cancel_status_id
    if "sources" in sent and data.sources is not None:
        config.sources = [s.strip() for s in data.sources if s.strip()]
    if data.clear_since:
        config.since = None
    elif "since" in sent and data.since is not None:
        config.since = data.since
    elif first_setup and config.status_ids and config.since is None:
        config.since = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
    await svc.write_config(db, config)
    if "api_token" in sent and data.api_token is not None:
        await svc.write_token(db, data.api_token)
    if config.handling_days != handling_days:
        await db.flush()
        await _replan(db, await svc.refresh_accepted(db, refresh_due=True))
    await db.commit()
    return await _settings_out(db)


class BaseTokenTest(BaseModel):
    # A token to try before saving it; without one, the stored token.
    api_token: str | None = Field(None, max_length=200)


@router.post("/test")
async def test_connection(
    data: BaseTokenTest,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict:
    """Read Base's order statuses and order sources with the token (for the settings' choices)."""
    token = (data.api_token or "").strip() or await svc.read_token(db)
    if not token:
        raise HTTPException(400, "Enter the Base API token")
    client = svc.BaseClient(token)
    try:
        statuses = await svc.fetch_statuses(client)
        sources = await svc.fetch_sources(client)
    except svc.BaseApiError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {
        "statuses": statuses,
        "sources": [{"key": key, "name": name} for key, name in sorted(sources.items(), key=lambda kv: kv[1].lower())],
    }


@router.post("/sync")
async def sync_now(_: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE)) -> dict:
    """Run the sync now (whether or not it is switched on)."""
    try:
        result = await svc.run_once()
    except svc.BaseApiError as exc:
        raise HTTPException(502, str(exc)) from exc
    assert result is not None
    return {
        "seen": result.seen,
        "new": result.new,
        "updated": result.updated,
        "cancelled": result.cancelled,
        "packed": result.packed,
        "replanned": result.replanned,
        "unmapped": result.unmapped,
    }


# --- orders --------------------------------------------------------------------------------


class OrderLineOut(BaseModel):
    sku: str
    name: str
    quantity: int
    attributes: str = ""
    # "product" (product_id, units), "not_printed", or "unmapped".
    mapping: str
    product_id: int | None = None
    product_name: str | None = None
    units: int = 1
    # The product's picture: GET /products/{id}/thumbnail?v=<version>.
    has_thumbnail: bool = False
    thumbnail_version: str | None = None


class ProductOrderRef(BaseModel):
    id: int
    product_id: int
    quantity: int
    status: str


class PartProgress(BaseModel):
    part_id: int
    name: str
    # Pieces there for the order now (stock, printed), of the ones it needs.
    ready: int
    needed: int
    # Of them, put in as on hand for this order (from the shelf).
    on_hand: int = 0
    # Pieces it needs that are neither there nor coming from a job in the queue
    # (its print was deleted, cancelled or stopped): sending it again plans them.
    missing: int = 0


class ProductProgress(BaseModel):
    product_id: int
    product_order_id: int
    status: str
    units: int
    units_ready: int
    estimated_ready_at: UTCDatetime = None
    parts: list[PartProgress]


class DraftOut(BaseModel):
    # product id -> products held back; part id -> pieces on hand (saved, not applied yet).
    held: dict[int, int]
    on_hand: dict[int, int]
    # The choice leaves nothing to print: every product held back or all its parts on hand.
    nothing_to_print: bool = False


class BaseOrderOut(BaseModel):
    order_id: int
    number: str | None
    # What its prints are labelled with: an Allegro nick, else the shop's number.
    label: str
    buyer_login: str | None = None
    source: str | None
    # "allegro" for every Allegro account, "shop" for the rest.
    source_kind: str
    source_name: str | None
    date_confirmed: UTCDatetime = None
    # The marketplace's ship-by deadline: the product orders' due date.
    ship_by: UTCDatetime = None
    state: str
    in_status: bool
    # Gone from the statuses, not cancelled: packed in Base (to send, or sent).
    packed: bool = False
    lines: list[OrderLineOut]
    product_orders: list[ProductOrderRef]
    # product id -> products held back from printing for this order.
    held: dict[int, int] = Field(default_factory=dict)
    # part id -> pieces on hand put into stock for this order.
    on_hand: dict[int, int] = Field(default_factory=dict)
    # A waiting order's saved choice, applied when it is sent.
    draft: DraftOut | None = None
    # An order in production: its products' parts there of the ones needed, and when it is expected.
    progress: list[ProductProgress] = Field(default_factory=list)
    # Every product order is done: the order can be packed.
    ready: bool = False


async def _orders_out(db: AsyncSession, rows: list[BaseOrder]) -> list[BaseOrderOut]:
    from backend.app.models.products import ProductPlate
    from backend.app.services import products as product_service

    skus = await svc.sku_map(db)
    wanted_ids = {t.product_id for t in skus.values() if t.product_id is not None}
    products = {
        p.id: p
        for p in (
            await db.execute(
                select(Product)
                .where(Product.id.in_(wanted_ids))
                .options(
                    selectinload(Product.plates).selectinload(ProductPlate.library_file),
                    selectinload(Product.parts),
                )
            )
        ).scalars()
    }
    names = {pid: p.name for pid, p in products.items()}
    product_orders = await _product_orders_by_order(db, {row.order_id for row in rows})
    refs = {
        order_id: [
            ProductOrderRef(id=po.id, product_id=po.product_id, quantity=po.quantity, status=po.status) for po in found
        ]
        for order_id, found in product_orders.items()
    }
    progress = await _progress(
        db, [po for row in rows if row.state == "accepted" for po in product_orders.get(row.order_id, [])]
    )
    result = []
    for row in rows:
        lines = []
        for line in row.items or []:
            target = skus.get(str(line.get("sku") or "").casefold())
            if target is None:
                mapping, product_id, units = "unmapped", None, 1
            elif target.product_id is None:
                mapping, product_id, units = "not_printed", None, target.units
            else:
                mapping, product_id, units = "product", target.product_id, target.units
            lines.append(
                OrderLineOut(
                    sku=str(line.get("sku") or ""),
                    name=str(line.get("name") or ""),
                    quantity=int(line.get("quantity") or 0),
                    attributes=str(line.get("attributes") or ""),
                    mapping=mapping,
                    product_id=product_id,
                    product_name=names.get(product_id) if product_id else None,
                    units=units,
                    has_thumbnail=bool(product_id in products and product_service.has_thumbnail(products[product_id])),
                    thumbnail_version=(
                        product_service.thumbnail_version(products[product_id]) if product_id in products else None
                    ),
                )
            )
        own = refs.get(row.order_id, [])
        live = [r for r in own if r.status != "cancelled"]
        on_hand = svc.on_hand_parts(row)
        draft_held, draft_on_hand = svc.draft_parts(row)
        wanted = {pid: n for pid, n in svc.wanted_products(row.items or [], skus).items() if pid in products}
        row_progress = []
        for po in product_orders.get(row.order_id, []):
            entry = progress.get(po.id)
            if entry is not None:
                for part in entry.parts:
                    part.on_hand = min(part.needed, on_hand.get(part.part_id, 0))
                row_progress.append(entry)
        result.append(
            BaseOrderOut(
                order_id=row.order_id,
                number=row.number,
                label=svc.order_label(row),
                buyer_login=row.buyer_login,
                source_kind="allegro" if row.source == "allegro" else "shop",
                draft=(
                    DraftOut(
                        held=draft_held,
                        on_hand=draft_on_hand,
                        nothing_to_print=_nothing_to_print(wanted, draft_held, draft_on_hand, products),
                    )
                    if row.draft
                    else None
                ),
                progress=row_progress,
                source=row.source,
                source_name=row.source_name,
                date_confirmed=row.date_confirmed,
                ship_by=row.ship_by,
                state=row.state,
                in_status=row.in_status,
                packed=svc.is_packed(row),
                lines=lines,
                product_orders=own,
                held=svc.held_products(row),
                on_hand=svc.on_hand_parts(row),
                ready=_ready(row, wanted, live),
            )
        )
    return result


def _nothing_to_print(
    wanted: dict[int, int], held: dict[int, int], on_hand: dict[int, int], products: dict[int, Product]
) -> bool:
    """A choice leaves nothing to print: each product is held back or has every part on hand."""
    from backend.app.services import products as product_service

    if not wanted:
        return False
    for product_id, units in wanted.items():
        units -= held.get(product_id, 0)
        if units <= 0:
            continue
        for spec in product_service.part_specs(products[product_id]):
            if on_hand.get(spec.id, 0) < units * spec.per_unit:
                return False
    return True


async def _product_orders_by_order(db: AsyncSession, order_ids: set[int]) -> dict[int, list[ProductOrder]]:
    """Base order id -> its product orders (every status)."""
    result: dict[int, list[ProductOrder]] = {}
    if not order_ids:
        return result
    found = (
        await db.execute(select(ProductOrder).where(ProductOrder.external_source == svc.EXTERNAL_SOURCE))
    ).scalars()
    for po in found:
        try:
            order_id = int((po.external_ref or "").split("/", 1)[0])
        except ValueError:
            continue
        if order_id in order_ids:
            result.setdefault(order_id, []).append(po)
    return result


async def _ready_orders(db: AsyncSession, rows: list[BaseOrder]) -> set[int]:
    """The ids of the accepted orders among ``rows`` that are ready (see ``_ready``)."""
    accepted = [row for row in rows if row.state == "accepted"]
    if not accepted:
        return set()
    skus = await svc.sku_map(db)
    wanted_ids = {t.product_id for t in skus.values() if t.product_id is not None}
    existing = set((await db.execute(select(Product.id).where(Product.id.in_(wanted_ids)))).scalars())
    product_orders = await _product_orders_by_order(db, {row.order_id for row in accepted})
    ready = set()
    for row in accepted:
        wanted = {pid: n for pid, n in svc.wanted_products(row.items or [], skus).items() if pid in existing}
        live = [po for po in product_orders.get(row.order_id, []) if po.status != "cancelled"]
        if _ready(row, wanted, live):
            ready.add(row.order_id)
    return ready


def _ready(row: BaseOrder, wanted: dict[int, int], live: list) -> bool:
    """An accepted order is ready: every product printed for it is done, the rest held back.

    Holding back every product leaves it no product order, and it is ready all the same.
    Ready orders are listed apart from the ones in production (``state=ready``).
    """
    if row.state != "accepted" or not (live or wanted):
        return False
    if any(r.status != "done" for r in live):
        return False
    held = svc.held_products(row)
    done = {r.product_id for r in live}
    return all(product_id in done for product_id, n in wanted.items() if n - held.get(product_id, 0) > 0)


async def _progress(db: AsyncSession, orders: list[ProductOrder]) -> dict[int, ProductProgress]:
    """Product order id -> its parts there of the ones it needs, and when it is expected (open ones)."""
    from backend.app.services import product_planner as planner, products as product_service
    from backend.app.services.queue_forecast import build_queue_forecast

    result: dict[int, ProductProgress] = {}
    live = [po for po in orders if po.status in ("open", "done")]
    forecast = None
    for product_id in sorted({po.product_id for po in live}):
        product = await product_service.load_product(db, product_id)
        if product is None:
            continue
        specs = product_service.part_specs(product)
        names = {p.id: p.name for p in product.parts}
        open_rows = await product_service.open_orders(db, product_id)
        pool = await product_service.stock_pool(db, product)
        needs = product_service.needs_of(open_rows)
        allocation = planner.allocate(specs, pool, needs)
        # The same with the pieces still coming from the queue: what is left over is missing.
        coming = {part_id: dict(by_printer) for part_id, by_printer in pool.items()}
        part_ids = {spec.id for spec in specs}
        for job in await product_service.queued_jobs(db, product_id):
            planner.pool_add(coming, product_service.piece_printer(job), product_service.counted_pieces(job, part_ids))
        with_queue = planner.allocate(specs, coming, needs)
        estimates = {}
        if open_rows:
            if forecast is None:
                forecast = await build_queue_forecast(db)
            estimates = await product_service.order_estimates(db, product, pool, open_rows, forecast)
        for po in (po for po in live if po.product_id == product_id):
            done = po.status == "done"
            parts = [
                PartProgress(
                    part_id=spec.id,
                    name=names.get(spec.id, ""),
                    ready=(
                        po.quantity * spec.per_unit
                        if done
                        else min(allocation.pieces.get(po.id, {}).get(spec.id, 0), po.quantity * spec.per_unit)
                    ),
                    needed=po.quantity * spec.per_unit,
                    missing=(
                        0
                        if done
                        else max(0, po.quantity * spec.per_unit - with_queue.pieces.get(po.id, {}).get(spec.id, 0))
                    ),
                )
                for spec in specs
            ]
            result[po.id] = ProductProgress(
                product_id=product_id,
                product_order_id=po.id,
                status=po.status,
                units=po.quantity,
                units_ready=po.quantity if done else allocation.units.get(po.id, 0),
                estimated_ready_at=None if done else _utc(estimates.get(po.id)),
                parts=parts,
            )
    return result


@router.get("/orders/counts")
async def order_counts(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess) -> dict:
    """How many orders each state has, from Allegro and from the rest (for the filters).

    Accepted orders that are ready count under ``ready``, not ``accepted``; so
    do waiting and accepted ones packed in Base (gone from the statuses).
    """
    counts = {state: {"allegro": 0, "shop": 0} for state in ("new", "accepted", "ready", "skipped", "cancelled")}
    rows = await db.execute(
        select(BaseOrder.state, BaseOrder.source, BaseOrder.in_status, func.count()).group_by(
            BaseOrder.state, BaseOrder.source, BaseOrder.in_status
        )
    )
    for state, source, in_status, n in rows.all():
        if state in ("new", "accepted") and not in_status:
            state = "ready"
        counts.setdefault(state, {"allegro": 0, "shop": 0})["allegro" if source == "allegro" else "shop"] += n
    accepted = list(
        (
            await db.execute(select(BaseOrder).where(BaseOrder.state == "accepted", BaseOrder.in_status.is_(True)))
        ).scalars()
    )
    ready = await _ready_orders(db, accepted)
    for row in accepted:
        if row.order_id in ready:
            kind = "allegro" if row.source == "allegro" else "shop"
            counts["accepted"][kind] -= 1
            counts["ready"][kind] += 1
    return counts


@router.get("/orders", response_model=list[BaseOrderOut])
async def list_orders(
    state: str | None = None,
    source: Literal["allegro", "shop"] | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _=ReadAccess,
):
    """Orders the sync found; ``state`` filters (new, accepted, ready, skipped, cancelled), ``source``
    too (``allegro``: every Allegro account; ``shop``: every other source).

    ``accepted`` is the orders in production; ``ready`` the accepted ones that
    are ready (printed, or held back in full), which ``accepted`` leaves out,
    and after them the waiting and accepted ones packed in Base (gone from the
    statuses; ``packed``), which ``new`` and ``accepted`` leave out.

    Waiting and accepted ones come in the order they are to be made: by ship-by
    deadline (today and tomorrow first, then the day after, then later), then
    the ones without one (a shop's) oldest first. Ready ones the same, then the
    packed ones, newest first. The rest newest first.
    """
    if state == "ready":
        return await _ready_list(db, source)
    if state in ("new", "accepted"):
        query = select(BaseOrder).order_by(
            BaseOrder.ship_by.asc().nulls_last(),
            BaseOrder.date_confirmed.asc().nulls_last(),
            BaseOrder.order_id.asc(),
        )
    else:
        query = select(BaseOrder).order_by(BaseOrder.date_confirmed.desc().nulls_last(), BaseOrder.order_id.desc())
    if state:
        query = query.where(BaseOrder.state == state)
    if state in ("new", "accepted"):
        query = query.where(BaseOrder.in_status.is_(True))
    query = _of_source(query, source)
    if state != "accepted":
        rows = list((await db.execute(query.limit(300))).scalars())
        return await _orders_out(db, rows)
    # Which accepted ones are ready is worked out here, so the limit comes after.
    rows = list((await db.execute(query)).scalars())
    ready = await _ready_orders(db, rows)
    return await _orders_out(db, [row for row in rows if row.order_id not in ready][:300])


def _of_source(query, source: str | None):
    if source == "allegro":
        return query.where(BaseOrder.source == "allegro")
    if source == "shop":
        return query.where(or_(BaseOrder.source.is_(None), BaseOrder.source != "allegro"))
    return query


async def _ready_list(db: AsyncSession, source: str | None) -> list[BaseOrderOut]:
    """The ready orders in the statuses in the order of making, then the packed ones newest first."""
    in_status = _of_source(
        select(BaseOrder)
        .where(BaseOrder.state == "accepted", BaseOrder.in_status.is_(True))
        .order_by(
            BaseOrder.ship_by.asc().nulls_last(),
            BaseOrder.date_confirmed.asc().nulls_last(),
            BaseOrder.order_id.asc(),
        ),
        source,
    )
    rows = list((await db.execute(in_status)).scalars())
    ready = await _ready_orders(db, rows)
    rows = [row for row in rows if row.order_id in ready][:300]
    packed = _of_source(
        select(BaseOrder)
        .where(BaseOrder.state.in_(("new", "accepted")), BaseOrder.in_status.is_(False))
        .order_by(BaseOrder.date_confirmed.desc().nulls_last(), BaseOrder.order_id.desc()),
        source,
    )
    rows += list((await db.execute(packed.limit(300 - len(rows)))).scalars()) if len(rows) < 300 else []
    return await _orders_out(db, rows)


async def _get_order(db: AsyncSession, order_id: int) -> BaseOrder:
    row = await db.get(BaseOrder, order_id)
    if row is None:
        raise HTTPException(404, "Order not found")
    return row


async def _replan(db: AsyncSession, product_ids: set[int]) -> None:
    if product_ids:
        await svc.replan_products(db, product_ids, await svc.read_config(db))


class AcceptPart(BaseModel):
    part_id: int
    pieces: int = Field(ge=0, le=10000)


class AcceptProduct(BaseModel):
    product_id: int
    # Products to print; the rest of what the order's lines want is held back.
    units: int = Field(ge=0, le=10000)
    # Pieces there already, outside the stock Bambuddy counts (go into stock).
    have: list[AcceptPart] = Field(default_factory=list, max_length=20)


class AcceptIn(BaseModel):
    # Without products every mapped line is printed in full.
    products: list[AcceptProduct] | None = Field(None, max_length=100)


@router.post("/orders/{order_id}/accept", response_model=BaseOrderOut)
async def accept_order(
    order_id: int,
    data: AcceptIn | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Send an order to production, or change what an accepted one prints, then replan.

    Without a body (or without ``products``) every mapped line is printed in
    full. Per product, ``units`` says how many to print (the rest is held back
    and stays so when Base changes the line) and ``have`` the pieces of parts
    someone has already: they go into stock as pieces of no known printer,
    which pair with any printer's, so only the rest is printed.
    """
    row = await _get_order(db, order_id)
    if row.state == "cancelled":
        raise HTTPException(409, "The order was cancelled in Base")
    if svc.is_packed(row):
        raise HTTPException(409, "The order is packed in Base: nothing to print for it")
    choices = None
    if data is not None and data.products is not None:
        choices = [
            svc.ProductChoice(p.product_id, p.units, {h.part_id: h.pieces for h in p.have if h.pieces > 0})
            for p in data.products
        ]
    try:
        changed = await svc.accept(db, row, choices)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await _replan(db, changed)
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


@router.post("/orders/{order_id}/draft", response_model=BaseOrderOut)
async def save_draft(
    order_id: int,
    data: AcceptIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Save a choice on a waiting order without sending it ("I have the base already"): nothing goes
    into stock or the queue. Per product, ``units`` to print and ``have`` the parts on hand, as for
    ``accept``; they replace the saved ones for those products. Sending the order applies them.
    """
    row = await _get_order(db, order_id)
    if row.state not in ("new", "skipped"):
        raise HTTPException(409, "Only a waiting order keeps a draft; change an accepted one with accept")
    if data.products is None:
        raise HTTPException(400, "Say what to keep: products")
    try:
        await svc.save_draft(
            db,
            row,
            [
                svc.ProductChoice(p.product_id, p.units, {h.part_id: h.pieces for h in p.have if h.pieces > 0})
                for p in data.products
            ],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


@router.post("/orders/{order_id}/reset", response_model=BaseOrderOut)
async def reset_order(
    order_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Take back sending (or skipping) an order: it waits again; its product orders are cancelled.

    What was held back is forgotten and the parts put into stock as on hand
    for it are taken out again. Then replan.
    """
    row = await _get_order(db, order_id)
    if row.state == "cancelled":
        raise HTTPException(409, "The order was cancelled in Base")
    await _replan(db, await svc.reset(db, row))
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


@router.post("/orders/{order_id}/requeue", response_model=BaseOrderOut)
async def requeue_order(
    order_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Send an order in production to print again: plan its products' open orders again.

    For pieces it is missing (``progress[].parts[].missing``) because its print
    left the queue: deleted, cancelled, or a print the printer never started.
    Waiting jobs that still fit stay; the plan only adds what is missing.
    """
    row = await _get_order(db, order_id)
    if row.state != "accepted":
        raise HTTPException(409, "Only an order in production can be sent again")
    products = {po.product_id for po in await svc.product_orders_of(db, order_id) if po.status == "open"}
    if not products:
        raise HTTPException(409, "Nothing of the order is left to print")
    await _replan(db, products)
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


class PlatePieceOut(BaseModel):
    part_id: int
    name: str
    pieces: int


class PlateFilamentOut(BaseModel):
    type: str
    color: str
    grams: float
    # The tray it takes (global tray id); None when no spool on the printer holds it.
    tray: int | None = None
    # Grams left on the spool after the plate; None when not known.
    left: float | None = None
    # "load" (no spool holds it) or "change" (the spool runs out first) before the plate.
    swap: str | None = None


class PlatePrinterOut(BaseModel):
    id: int
    name: str
    # Can take work now (connected, or an Auto On plug wakes it).
    available: bool


class OrderPlateOut(BaseModel):
    job_id: int
    queue_item_id: int | None
    product_id: int
    product_name: str
    library_file_id: int | None = None
    filename: str | None = None
    plate_index: int | None = None
    has_thumbnail: bool = False
    pieces: list[PlatePieceOut]
    # "planned" (waiting in the queue) or "printing".
    status: str
    # Prints matched parts: pinned to its printer.
    pinned: bool = False
    by_hand: bool = False
    moved: bool = False
    printer_id: int | None = None
    printer_name: str | None = None
    # From the queue forecast (a printing plate: its end only).
    start: UTCDatetime = None
    end: UTCDatetime = None
    preferred_printer_id: int | None = None
    # Why it is not on the preferred printer: earlier, filament, unavailable, pieces.
    overruled: str | None = None
    overruled_by_s: int = 0
    swap: str | None = None
    filament: list[PlateFilamentOut] = Field(default_factory=list)
    # The printers it may be preferred on: enabled, of the file's model, allowed by its tags.
    printers: list[PlatePrinterOut] = Field(default_factory=list)
    # A preferred printer can be set: a waiting plate of the plan's, not queued or moved by hand.
    editable: bool = False
    # The orders it prints for (one plate may print for several).
    orders: list[str] = Field(default_factory=list)


@router.get("/orders/{order_id}/plates", response_model=list[OrderPlateOut])
async def order_plates(order_id: int, db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    """The plates the plan prints for an order, the printing ones first, then by forecast start.

    Each says where and when it prints, the filament it takes and what is left
    after it, and the printers it may be preferred on
    (``PUT /products/jobs/{job_id}/preference``).
    """
    from backend.app.models.printer import Printer
    from backend.app.services import products as product_service

    await _get_order(db, order_id)
    product_orders = {po.id for po in await svc.product_orders_of(db, order_id) if po.status == "open"}
    plates = await product_service.order_plates(db, product_orders)
    names = dict((await db.execute(select(Printer.id, Printer.name))).all())
    result = []
    for entry in plates:
        job, plate, product = entry.job, entry.plate, entry.product
        info = job.plan_info or {}
        part_names = {p.id: p.name for p in product.parts}
        library_file = plate.library_file if plate is not None else None
        result.append(
            OrderPlateOut(
                job_id=job.id,
                queue_item_id=job.queue_item_id,
                product_id=product.id,
                product_name=product.name,
                library_file_id=library_file.id if library_file is not None else None,
                filename=library_file.filename if library_file is not None else None,
                plate_index=plate.plate_id if plate is not None else None,
                has_thumbnail=bool(library_file is not None and library_file.thumbnail_path),
                pieces=[
                    PlatePieceOut(part_id=part_id, name=part_names.get(part_id, f"#{part_id}"), pieces=n)
                    for part_id, n in product_service.job_pieces(job, set(part_names))
                ],
                status=entry.status,
                pinned=bool(job.pinned),
                by_hand=bool(job.by_hand),
                moved=entry.moved,
                printer_id=entry.printer_id,
                printer_name=names.get(entry.printer_id) if entry.printer_id is not None else None,
                start=_utc(entry.start),
                end=_utc(entry.end),
                preferred_printer_id=job.preferred_printer_id,
                overruled=info.get("overruled") if job.preferred_printer_id is not None else None,
                overruled_by_s=int(info.get("overruled_by_s") or 0),
                swap=info.get("swap"),
                filament=[PlateFilamentOut(**f) for f in info.get("filament") or [] if isinstance(f, dict)],
                printers=[PlatePrinterOut(id=c.printer_id, name=c.name, available=c.available) for c in entry.choices],
                editable=entry.status == "planned" and not job.by_hand and not entry.moved,
                orders=[tag.label for tag in entry.orders],
            )
        )
    return result


class SkipIn(BaseModel):
    # Its done product orders too: what was printed for it goes back to stock
    # (the boxes are on the shelf), for the next orders of the product.
    return_done: bool = False


@router.post("/orders/{order_id}/skip", response_model=BaseOrderOut)
async def skip_order(
    order_id: int,
    data: SkipIn | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Leave an order out, or withdraw one in production: its open product orders are cancelled.

    ``return_done`` cancels its done ones too, their pieces back in stock.
    Sending it again (``accept``) undoes it, with what was held back and on
    hand as before.
    """
    row = await _get_order(db, order_id)
    await _replan(db, await svc.skip(db, row, return_done=bool(data and data.return_done)))
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


class PieceRef(BaseModel):
    part_id: int
    name: str
    pieces: int


class PrintRef(BaseModel):
    queue_item_id: int | None = None
    filename: str | None = None
    printer_name: str | None = None
    pieces: list[PieceRef] = Field(default_factory=list)


class DoneRef(BaseModel):
    product_id: int
    name: str
    units: int


class WithdrawPreviewOut(BaseModel):
    # Waiting prints that leave the queue.
    removed: list[PrintRef]
    # Plates the plan queues instead, for the orders that shared a plate with it.
    added: list[PrintRef]
    # Printing for it now: they finish, and their pieces go to stock.
    printing: list[PrintRef]
    # Pieces that end up in stock for no order because of it: printed for it,
    # printing for it, or made beyond the other orders by a plate they share.
    to_stock: list[PieceRef]
    # Products done for it (boxes on the shelf): back in stock with return_done.
    done: list[DoneRef]


@router.post("/orders/{order_id}/skip/preview", response_model=WithdrawPreviewOut)
async def preview_skip(
    order_id: int,
    data: SkipIn | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """What withdrawing an order would do to the queue and the stock; nothing is saved.

    The withdrawal and the plans it causes are worked out in this request's
    transaction and rolled back, so the answer is what ``skip`` with the same
    body would do now.
    """
    row = await _get_order(db, order_id)
    try:
        return await _withdraw_preview(db, row, bool(data and data.return_done))
    finally:
        await db.rollback()


async def _withdraw_preview(db: AsyncSession, row: BaseOrder, return_done: bool) -> WithdrawPreviewOut:
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.models.printer import Printer
    from backend.app.models.products import ProductJob
    from backend.app.services import product_planner as planner, products as product_service

    orders = await svc.product_orders_of(db, row.order_id)
    open_ids = {po.id for po in orders if po.status == "open"}
    products = {}
    for product_id in sorted({po.product_id for po in orders}):
        product = await product_service.load_product(db, product_id)
        if product is not None:
            products[product_id] = product
    part_names = {part.id: part.name for product in products.values() for part in product.parts}
    files = {
        plate.id: plate.library_file.filename if plate.library_file is not None else None
        for product in products.values()
        for plate in product.plates
    }
    printer_names = dict((await db.execute(select(Printer.id, Printer.name))).all())

    def pieces_of(counts: dict[int, int]) -> list[PieceRef]:
        return [
            PieceRef(part_id=part_id, name=part_names.get(part_id, f"#{part_id}"), pieces=n)
            for part_id, n in sorted(counts.items())
            if n > 0
        ]

    def print_ref(job) -> PrintRef:
        return PrintRef(
            queue_item_id=job.queue_item_id,
            filename=files.get(job.product_plate_id or -1),
            printer_name=printer_names.get(job.printer_id),
            pieces=pieces_of(dict(product_service.job_pieces(job, set(part_names)))),
        )

    async def surplus() -> dict[int, int]:
        """Pieces in stock or coming from the queue that no open order takes, per part."""
        result: dict[int, int] = {}
        for product in products.values():
            specs = product_service.part_specs(product)
            ids = {spec.id for spec in specs}
            coming = await product_service.stock_pool(db, product)
            for job in await product_service.queued_jobs(db, product.id):
                planner.pool_add(coming, product_service.piece_printer(job), product_service.counted_pieces(job, ids))
            needs = product_service.needs_of(await product_service.open_orders(db, product.id))
            taken = planner.allocate(specs, coming, needs)
            for spec in specs:
                total = sum((coming.get(spec.id) or {}).values())
                used = sum(by_part.get(spec.id, 0) for by_part in taken.pieces.values())
                result[spec.id] = result.get(spec.id, 0) + max(0, total - used)
        return result

    # Before: what prints for it, and what no order takes yet.
    by_item, _ = await product_service.order_tags(db)
    queued = [job for product_id in products for job in await product_service.queued_jobs(db, product_id)]
    # Started or being sent: the queue job says so before the planner's job follows it.
    started = set(
        (
            await db.execute(
                select(PrintQueueItem.id).where(
                    PrintQueueItem.id.in_([job.queue_item_id for job in queued if job.queue_item_id is not None]),
                    or_(PrintQueueItem.status == "printing", PrintQueueItem.dispatching_at.is_not(None)),
                )
            )
        ).scalars()
    )
    waiting = {}
    printing = []
    for job in queued:
        if job.status == "printing" or job.queue_item_id in started:
            served = by_item.get(job.queue_item_id) if job.queue_item_id is not None else None
            if served is not None and any(tag.product_order_id in open_ids for tag in served.orders):
                printing.append(print_ref(job))
        elif job.queue_item_id is not None:
            waiting[job.queue_item_id] = print_ref(job)
    before = await surplus()
    done = [
        DoneRef(product_id=po.product_id, name=products[po.product_id].name, units=po.quantity)
        for po in orders
        if po.status == "done" and po.product_id in products
    ]

    # Withdraw and plan, then compare.
    config = await svc.read_config(db)
    added_ids: list[int] = []
    for product_id in sorted(await svc.skip(db, row, return_done=return_done)):
        outcome = await product_service.replan(
            db, product_id, actor_id=None, manual_start=config.manual_start, printer_ids=None
        )
        added_ids += outcome.item_ids
    after_jobs = list(
        (
            await db.execute(
                select(ProductJob).where(
                    ProductJob.product_id.in_(list(products)), ProductJob.status.in_(product_service.JOB_ACTIVE)
                )
            )
        ).scalars()
    )
    still = {job.queue_item_id for job in after_jobs}
    after = await surplus()
    return WithdrawPreviewOut(
        removed=[ref for item_id, ref in waiting.items() if item_id not in still],
        added=[print_ref(job) for job in after_jobs if job.queue_item_id in set(added_ids)],
        printing=printing,
        to_stock=pieces_of({part_id: after.get(part_id, 0) - before.get(part_id, 0) for part_id in after}),
        done=done,
    )


# --- SKUs ------------------------------------------------------------------------------------


class SkuOut(BaseModel):
    sku: str
    # None: not printed.
    product_id: int | None
    product_name: str | None = None
    units: int


class UnmappedSku(BaseModel):
    sku: str
    name: str
    orders: int


class SkusOut(BaseModel):
    mapped: list[SkuOut]
    unmapped: list[UnmappedSku]


class SkuIn(IgnoresNullForRequiredColumns):
    # A null product_id is meaningful (not printed): that column may be null,
    # so the mixin keeps it; a null units counts as not sent.
    __orm_table__ = "custom_product_skus"

    product_id: int | None = None
    units: int = Field(1, ge=1, le=1000)


@router.get("/skus", response_model=SkusOut)
async def list_skus(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    """The SKU map, and the SKUs of waiting or accepted orders that map to nothing yet."""
    names = dict((await db.execute(select(Product.id, Product.name))).all())
    mapped = [
        SkuOut(sku=row.sku, product_id=row.product_id, product_name=names.get(row.product_id), units=row.units)
        for row in (await db.execute(select(ProductSku).order_by(ProductSku.sku))).scalars()
    ]
    skus = await svc.sku_map(db)
    rows = list((await db.execute(select(BaseOrder))).scalars())
    unmapped = [
        UnmappedSku(sku=sku, name=entry["name"], orders=entry["orders"])
        for sku, entry in sorted(svc.unmapped_lines(rows, skus).items())
    ]
    return SkusOut(mapped=mapped, unmapped=unmapped)


@router.put("/skus/{sku:path}", response_model=SkuOut)
async def put_sku(
    sku: str,
    data: SkuIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Map a SKU to a product (``units`` of it), or mark it not printed; accepted orders follow, then replan."""
    sku = sku.strip()
    if not sku or len(sku) > 100:
        raise HTTPException(400, "A SKU is 1 to 100 characters")
    product_name = None
    if data.product_id is not None:
        product = await db.get(Product, data.product_id)
        if product is None:
            raise HTTPException(404, "Product not found")
        product_name = product.name
    row = (await db.execute(select(ProductSku).where(ProductSku.sku == sku))).scalar_one_or_none()
    if row is None:
        row = ProductSku(sku=sku)
        db.add(row)
    row.product_id = data.product_id
    row.units = data.units
    await db.flush()
    await _replan(db, await svc.refresh_accepted(db, sku))
    await db.commit()
    return SkuOut(sku=row.sku, product_id=row.product_id, product_name=product_name, units=row.units)


@router.delete("/skus/{sku:path}")
async def delete_sku(
    sku: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Forget a SKU's mapping; accepted orders drop its lines, then replan."""
    row = (await db.execute(select(ProductSku).where(ProductSku.sku == sku.strip()))).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "SKU not mapped")
    await db.delete(row)
    await db.flush()
    await _replan(db, await svc.refresh_accepted(db, sku))
    await db.commit()
    return {"deleted": sku}
