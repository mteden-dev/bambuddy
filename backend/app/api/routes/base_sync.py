"""Orders from Base (base.com) for products: settings, the sync, orders, SKUs (fork).

How it works is in services/base_sync.py. Read-only towards Base.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    status_id: int | None = None
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
    status_id: int | None
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

    Setting the status for the first time without a date sets ``since`` to now:
    orders already in the status before are not taken. ``clear_since`` takes
    every order Base returns instead (its last 3 months).
    """
    config = await svc.read_config(db)
    first_setup = config.status_id is None
    sent = data.model_fields_set
    for name in ("enabled", "status_id", "poll_minutes", "auto_accept", "manual_start", "handling_days"):
        value = getattr(data, name)
        if name in sent and value is not None:
            setattr(config, name, value)
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
    elif first_setup and config.status_id is not None and config.since is None:
        config.since = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
    await svc.write_config(db, config)
    if "api_token" in sent and data.api_token is not None:
        await svc.write_token(db, data.api_token)
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


class ProductOrderRef(BaseModel):
    id: int
    product_id: int
    quantity: int
    status: str


class BaseOrderOut(BaseModel):
    order_id: int
    number: str | None
    source: str | None
    source_name: str | None
    date_confirmed: UTCDatetime = None
    state: str
    in_status: bool
    lines: list[OrderLineOut]
    product_orders: list[ProductOrderRef]
    # Every product order is done: the order can be packed.
    ready: bool = False


async def _orders_out(db: AsyncSession, rows: list[BaseOrder]) -> list[BaseOrderOut]:
    skus = await svc.sku_map(db)
    names = dict((await db.execute(select(Product.id, Product.name))).all())
    refs: dict[int, list[ProductOrderRef]] = {}
    if rows:
        found = (
            await db.execute(select(ProductOrder).where(ProductOrder.external_source == svc.EXTERNAL_SOURCE))
        ).scalars()
        wanted = {row.order_id for row in rows}
        for po in found:
            try:
                order_id = int((po.external_ref or "").split("/", 1)[0])
            except ValueError:
                continue
            if order_id in wanted:
                refs.setdefault(order_id, []).append(
                    ProductOrderRef(id=po.id, product_id=po.product_id, quantity=po.quantity, status=po.status)
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
                )
            )
        own = refs.get(row.order_id, [])
        live = [r for r in own if r.status != "cancelled"]
        result.append(
            BaseOrderOut(
                order_id=row.order_id,
                number=row.number,
                source=row.source,
                source_name=row.source_name,
                date_confirmed=row.date_confirmed,
                state=row.state,
                in_status=row.in_status,
                lines=lines,
                product_orders=own,
                ready=row.state == "accepted" and bool(live) and all(r.status == "done" for r in live),
            )
        )
    return result


@router.get("/orders", response_model=list[BaseOrderOut])
async def list_orders(
    state: str | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _=ReadAccess,
):
    """Orders the sync found, newest first; ``state`` filters (new, accepted, skipped, cancelled)."""
    query = select(BaseOrder).order_by(BaseOrder.date_confirmed.desc().nulls_last(), BaseOrder.order_id.desc())
    if state:
        query = query.where(BaseOrder.state == state)
    rows = list((await db.execute(query.limit(300))).scalars())
    return await _orders_out(db, rows)


async def _get_order(db: AsyncSession, order_id: int) -> BaseOrder:
    row = await db.get(BaseOrder, order_id)
    if row is None:
        raise HTTPException(404, "Order not found")
    return row


async def _replan(db: AsyncSession, product_ids: set[int]) -> None:
    if product_ids:
        await svc.replan_products(db, product_ids, await svc.read_config(db))


@router.post("/orders/{order_id}/accept", response_model=BaseOrderOut)
async def accept_order(
    order_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Send an order to production: its mapped lines become product orders, then replan."""
    row = await _get_order(db, order_id)
    if row.state == "cancelled":
        raise HTTPException(409, "The order was cancelled in Base")
    await _replan(db, await svc.accept(db, row))
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


@router.post("/orders/{order_id}/skip", response_model=BaseOrderOut)
async def skip_order(
    order_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Leave an order out (from stock, by hand): its open product orders are cancelled."""
    row = await _get_order(db, order_id)
    await _replan(db, await svc.skip(db, row))
    await db.commit()
    return (await _orders_out(db, [await _get_order(db, order_id)]))[0]


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
