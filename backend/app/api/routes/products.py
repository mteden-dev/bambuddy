"""Products, orders for them, and the plan that prints them (fork).

How orders become queue jobs is in services/products.py and
services/product_planner.py.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import (
    ApiKeyActor,
    QueueReviewRequired,
    RequestActor,
    RequestPrinterScope,
    RequirePermissionIfAuthEnabled,
    require_ownership_permission,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.library import LibraryFile
from backend.app.models.printer import Printer
from backend.app.models.products import (
    Product,
    ProductOrder,
    ProductPart,
    ProductPlate,
    ProductPlatePart,
    ProductStockAdjustment,
)
from backend.app.models.user import User
from backend.app.schemas.not_null import IgnoresNullForRequiredColumns
from backend.app.schemas.print_queue import NaiveUTCDatetime, UTCDatetime
from backend.app.services import product_planner as planner, products as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/products", tags=["products"])

ReadAccess = Depends(require_ownership_permission(Permission.QUEUE_READ_ALL, Permission.QUEUE_READ_OWN))
RECENT_ORDERS = 20


# --- request bodies ------------------------------------------------------------


class PartIn(BaseModel):
    # An existing part keeps its id (and its stock); a part without one is new.
    id: int | None = None
    name: str = Field(min_length=1, max_length=255)
    quantity: int = Field(1, ge=1, le=100)
    matched: bool = False


class PlatePieceIn(BaseModel):
    # Index into the product's ``parts`` as sent.
    part: int = Field(ge=0)
    pieces: int = Field(ge=1, le=1000)


class PlateIn(BaseModel):
    library_file_id: int
    plate_id: int | None = Field(None, ge=1)
    pieces: list[PlatePieceIn] = Field(min_length=1, max_length=20)


class ProductIn(IgnoresNullForRequiredColumns):
    # Replaces the product as a whole; a null name counts as not sent (a 422).
    __orm_table__ = "custom_products"

    name: str = Field(min_length=1, max_length=255)
    notes: str | None = Field(None, max_length=5000)
    parts: list[PartIn] = Field(min_length=1, max_length=20)
    plates: list[PlateIn] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _pieces_name_parts(self) -> ProductIn:
        for plate in self.plates:
            seen = set()
            for piece in plate.pieces:
                if piece.part >= len(self.parts):
                    raise ValueError(f"A plate names part {piece.part}, but there are {len(self.parts)} parts")
                if piece.part in seen:
                    raise ValueError("A plate names the same part twice")
                seen.add(piece.part)
        return self


class OrderIn(BaseModel):
    quantity: int = Field(ge=1, le=10000)
    due_date: NaiveUTCDatetime = None
    notes: str | None = Field(None, max_length=5000)
    external_source: str | None = Field(None, min_length=1, max_length=32, pattern=r"^[a-z0-9_-]+$")
    external_ref: str | None = Field(None, min_length=1, max_length=255)

    @model_validator(mode="after")
    def _external_pair(self) -> OrderIn:
        if (self.external_source is None) != (self.external_ref is None):
            raise ValueError("external_source and external_ref go together")
        return self


class OrderUpdate(IgnoresNullForRequiredColumns):
    __orm_table__ = "custom_product_orders"

    quantity: int | None = Field(None, ge=1, le=10000)
    due_date: NaiveUTCDatetime = None
    clear_due_date: bool = False
    notes: str | None = Field(None, max_length=5000)


class StockIn(BaseModel):
    part_id: int
    printer_id: int | None = None
    delta: int = Field(ge=-10000, le=10000)
    note: str | None = Field(None, max_length=255)

    @model_validator(mode="after")
    def _not_zero(self) -> StockIn:
        if self.delta == 0:
            raise ValueError("delta must not be 0")
        return self


class ProductSettings(IgnoresNullForRequiredColumns):
    # Stored in one settings row, so no column says it can't be null; the field
    # is required, and a null is a 422.
    __orm_table__ = "settings"

    # What one more plate costs, as minutes of waiting: work, a plate change.
    plate_cost_minutes: int = Field(ge=0, le=svc.MAX_PLATE_COST_MINUTES)


# --- responses -------------------------------------------------------------------


class PartPieces(BaseModel):
    part_id: int
    pieces: int


class PlateFile(BaseModel):
    library_file_id: int
    filename: str | None = None
    print_name: str | None = None
    model: str | None = None
    print_time_seconds: int | None = None
    filament_grams: float | None = None
    # Objects on the file's plate, when the file has one plate.
    object_count: int | None = None
    has_thumbnail: bool = False
    # In the trash or gone: the planner skips the plate.
    missing: bool = False


class PartOut(BaseModel):
    id: int
    name: str
    quantity: int
    matched: bool


class PlateOut(BaseModel):
    id: int
    library_file_id: int
    plate_id: int | None
    pieces: list[PartPieces]
    file: PlateFile


class ProductOut(BaseModel):
    id: int
    name: str
    notes: str | None
    parts: list[PartOut]
    plates: list[PlateOut]
    open_orders: int = 0
    open_units: int = 0
    created_at: UTCDatetime = None


class StockOut(BaseModel):
    part_id: int
    # 0 when the pieces' printer is not known.
    printer_id: int
    printer_name: str | None
    pieces: int


class OrderPart(BaseModel):
    part_id: int
    ready: int
    needed: int


class OrderOut(BaseModel):
    id: int
    quantity: int
    due_date: UTCDatetime = None
    notes: str | None
    status: str
    created_at: UTCDatetime = None
    completed_at: UTCDatetime = None
    units_ready: int = 0
    parts: list[OrderPart] = Field(default_factory=list)
    # From the queue forecast; None when nothing planned finishes it.
    estimated_ready_at: UTCDatetime = None
    external_source: str | None = None
    external_ref: str | None = None


class JobOut(BaseModel):
    id: int
    queue_item_id: int | None
    status: str
    printer_id: int | None
    printer_name: str | None
    pinned: bool
    pieces: list[PartPieces]
    product_plate_id: int | None
    filename: str | None
    print_time_seconds: int | None


class ProductDetail(ProductOut):
    stock: list[StockOut] = Field(default_factory=list)
    orders: list[OrderOut] = Field(default_factory=list)
    jobs: list[JobOut] = Field(default_factory=list)
    # Pieces the open orders still need that no job in the queue will make
    # (a planner job someone deleted): replanning puts them back.
    unplanned: list[PartPieces] = Field(default_factory=list)


class PlanOut(BaseModel):
    product: ProductDetail
    planned_jobs: int
    replaced: int
    # order id -> when the plan expects it ready
    ready_at: dict[int, UTCDatetime] = Field(default_factory=dict)
    finish_at: UTCDatetime = None
    short: list[PartPieces] = Field(default_factory=list)
    extra: list[PartPieces] = Field(default_factory=list)
    skipped_plates: list[dict] = Field(default_factory=list)


# --- building responses ------------------------------------------------------------


def _utc(value: datetime | None) -> datetime | None:
    """Naive UTC, the form UTCDatetime writes with a Z (the planner works in aware times)."""
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _plate_file(plate: ProductPlate) -> PlateFile:
    library_file = plate.library_file
    if library_file is None:
        return PlateFile(library_file_id=plate.library_file_id, missing=True)
    return _file_info(library_file, plate)


def _file_info(library_file: LibraryFile, plate: ProductPlate | None = None) -> PlateFile:
    meta = library_file.file_metadata or {}
    objects = meta.get("printable_objects")
    grams = meta.get("filament_used_grams")
    duration = svc.plate_duration(plate) if plate is not None else meta.get("print_time_seconds")
    return PlateFile(
        library_file_id=library_file.id,
        filename=library_file.filename,
        print_name=meta.get("print_name"),
        model=svc.plate_model(library_file),
        print_time_seconds=int(duration) if isinstance(duration, (int, float)) else None,
        filament_grams=float(grams) if isinstance(grams, (int, float)) else None,
        object_count=len(objects) if isinstance(objects, dict) and (plate is None or not plate.plate_id) else None,
        has_thumbnail=bool(library_file.thumbnail_path),
        missing=library_file.deleted_at is not None,
    )


async def _open_counts(db: AsyncSession, product_ids: list[int]) -> dict[int, tuple[int, int]]:
    if not product_ids:
        return {}
    rows = await db.execute(
        select(ProductOrder.product_id, func.count(ProductOrder.id), func.sum(ProductOrder.quantity))
        .where(ProductOrder.product_id.in_(product_ids), ProductOrder.status == "open")
        .group_by(ProductOrder.product_id)
    )
    return {pid: (count, int(units or 0)) for pid, count, units in rows.all()}


def _product_out(product: Product, counts: tuple[int, int] = (0, 0)) -> dict:
    return {
        "id": product.id,
        "name": product.name,
        "notes": product.notes,
        "parts": [PartOut(id=p.id, name=p.name, quantity=p.quantity, matched=p.matched) for p in product.parts],
        "plates": [
            PlateOut(
                id=plate.id,
                library_file_id=plate.library_file_id,
                plate_id=plate.plate_id,
                pieces=[PartPieces(part_id=p.part_id, pieces=p.pieces) for p in plate.pieces],
                file=_plate_file(plate),
            )
            for plate in product.plates
        ],
        "open_orders": counts[0],
        "open_units": counts[1],
        "created_at": product.created_at,
    }


def _order_out(order: ProductOrder, **extra) -> OrderOut:
    return OrderOut(
        id=order.id,
        quantity=order.quantity,
        due_date=order.due_date,
        notes=order.notes,
        status=order.status,
        created_at=order.created_at,
        completed_at=order.completed_at,
        external_source=order.external_source,
        external_ref=order.external_ref,
        **extra,
    )


async def _detail(db: AsyncSession, product: Product, *, estimates: bool = True) -> ProductDetail:
    pool = await svc.stock_pool(db, product)
    specs = svc.part_specs(product)
    part_ids = {p.id for p in product.parts}
    printer_names = dict((await db.execute(select(Printer.id, Printer.name))).all())

    stock = [
        StockOut(part_id=part_id, printer_id=printer_id, printer_name=printer_names.get(printer_id), pieces=n)
        for part_id, by_printer in sorted(pool.items())
        for printer_id, n in sorted(by_printer.items())
        if n != 0
    ]

    open_rows = await svc.open_orders(db, product.id)
    needs = svc.needs_of(open_rows)
    allocation = planner.allocate(specs, pool, needs)
    ready_at = await svc.order_estimates(db, product, pool, open_rows) if estimates else {}
    orders = [
        _order_out(
            order,
            units_ready=allocation.units.get(order.id, 0),
            parts=[
                OrderPart(
                    part_id=p.id,
                    ready=allocation.pieces.get(order.id, {}).get(p.id, 0),
                    needed=order.quantity * p.per_unit,
                )
                for p in specs
            ],
            estimated_ready_at=_utc(ready_at.get(order.id)),
        )
        for order in open_rows
    ]
    closed = (
        await db.execute(
            select(ProductOrder)
            .where(ProductOrder.product_id == product.id, ProductOrder.status != "open")
            .order_by(ProductOrder.completed_at.desc().nulls_last(), ProductOrder.id.desc())
            .limit(RECENT_ORDERS)
        )
    ).scalars()
    orders += [_order_out(order) for order in closed]

    jobs_rows = await svc.active_jobs(db, product.id)
    plates = {plate.id: plate for plate in product.plates}
    jobs = []
    coming = {part_id: dict(by_printer) for part_id, by_printer in pool.items()}
    for job in jobs_rows:
        pieces = svc.job_pieces(job, part_ids)
        planner.pool_add(coming, job.printer_id or planner.UNKNOWN_PRINTER, pieces)
        plate = plates.get(job.product_plate_id or -1)
        jobs.append(
            JobOut(
                id=job.id,
                queue_item_id=job.queue_item_id,
                status=job.status,
                printer_id=job.printer_id,
                printer_name=printer_names.get(job.printer_id),
                pinned=job.pinned,
                pieces=[PartPieces(part_id=pid, pieces=n) for pid, n in pieces],
                product_plate_id=job.product_plate_id,
                filename=plate.library_file.filename if plate is not None and plate.library_file else None,
                print_time_seconds=svc.plate_duration(plate) if plate is not None else None,
            )
        )
    with_jobs = planner.allocate(specs, coming, needs)
    unplanned = []
    for p in specs:
        short = sum(o.units * p.per_unit - with_jobs.pieces.get(o.id, {}).get(p.id, 0) for o in needs)
        if short > 0:
            unplanned.append(PartPieces(part_id=p.id, pieces=short))

    counts = (len(open_rows), sum(o.quantity for o in open_rows))
    return ProductDetail(
        **_product_out(product, counts),
        stock=stock,
        orders=orders,
        jobs=jobs,
        unplanned=unplanned,
    )


async def _get_product(db: AsyncSession, product_id: int) -> Product:
    product = await svc.load_product(db, product_id)
    if product is None:
        raise HTTPException(404, "Product not found")
    return product


async def _write_product(db: AsyncSession, product: Product, data: ProductIn, actor: User | ApiKeyActor | None) -> None:
    """Apply ``data`` to ``product``: parts by id, plates replaced. The caller commits."""
    from backend.app.api.routes.print_queue import _assert_can_queue_library_file

    existing = {p.id: p for p in product.parts}
    for part in data.parts:
        if part.id is not None and part.id not in existing:
            raise HTTPException(400, f"Part {part.id} is not a part of this product")
    file_ids = {plate.library_file_id for plate in data.plates}
    files = {}
    if file_ids:
        rows = (await db.execute(LibraryFile.active().where(LibraryFile.id.in_(file_ids)))).scalars()
        files = {f.id: f for f in rows}
    for file_id in file_ids:
        library_file = files.get(file_id)
        if library_file is None:
            raise HTTPException(404, f"Library file {file_id} not found")
        _assert_can_queue_library_file(library_file, actor)
        if not svc.plate_model(library_file):
            raise HTTPException(
                400,
                f"{library_file.filename} does not say which printer it was sliced for; "
                "slice it or set its printer in File Manager",
            )

    product.name = data.name.strip()
    product.notes = data.notes
    kept_ids = {part.id for part in data.parts if part.id is not None}
    for part_id, part in existing.items():
        if part_id not in kept_ids:
            await db.delete(part)
    parts: list[ProductPart] = []
    for index, part in enumerate(data.parts):
        row = existing.get(part.id) if part.id is not None else None
        if row is None:
            row = ProductPart(product_id=product.id)
            db.add(row)
        row.name = part.name.strip()
        row.quantity = part.quantity
        row.matched = part.matched
        row.sort_order = index
        parts.append(row)
    for plate in list(product.plates):
        await db.delete(plate)
    await db.flush()
    for index, plate in enumerate(data.plates):
        row = ProductPlate(
            product_id=product.id, library_file_id=plate.library_file_id, plate_id=plate.plate_id, sort_order=index
        )
        db.add(row)
        await db.flush()
        for piece in plate.pieces:
            db.add(ProductPlatePart(plate_id=row.id, part_id=parts[piece.part].id, pieces=piece.pieces))
    await db.flush()


async def _plan_response(
    db: AsyncSession, product_id: int, actor: User | ApiKeyActor | None, review_required: bool, scope: PrinterScope
) -> PlanOut:
    outcome = await svc.replan(
        db,
        product_id,
        actor_id=actor.id if actor is not None else None,
        manual_start=review_required,
        printer_ids=scope.printer_ids,
    )
    await db.commit()
    await svc.announce_planned(outcome.item_ids)
    product = await _get_product(db, product_id)
    plan = outcome.plan
    plates = plan.plates if plan is not None else []
    logger.info("[PRODUCTS] Planned product %s: %s plates, %s replaced", product_id, len(plates), outcome.replaced)
    return PlanOut(
        product=await _detail(db, product),
        planned_jobs=len(outcome.item_ids),
        replaced=outcome.replaced,
        ready_at={k: _utc(v) for k, v in (plan.ready_at if plan else {}).items() if v is not None},
        finish_at=_utc(max((p.ready for p in plates), default=None)),
        short=[PartPieces(part_id=k, pieces=v) for k, v in sorted((plan.short if plan else {}).items())],
        extra=[PartPieces(part_id=k, pieces=v) for k, v in sorted((plan.extra if plan else {}).items())],
        skipped_plates=[{"plate_id": pid, "reason": why} for pid, why in outcome.skipped_plates],
    )


# --- routes --------------------------------------------------------------------------


@router.get("", response_model=list[ProductOut])
@router.get("/", response_model=list[ProductOut])
async def list_products(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    rows = list((await db.execute(select(Product.id).order_by(func.lower(Product.name), Product.id))).scalars())
    counts = await _open_counts(db, rows)
    result = []
    for product_id in rows:
        product = await svc.load_product(db, product_id)
        if product is not None:
            result.append(ProductOut(**_product_out(product, counts.get(product_id, (0, 0)))))
    return result


@router.get("/settings", response_model=ProductSettings)
async def get_product_settings(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    return ProductSettings(plate_cost_minutes=await svc.read_plate_cost_minutes(db))


@router.put("/settings", response_model=ProductSettings)
async def put_product_settings(
    data: ProductSettings,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    await svc.write_plate_cost_minutes(db, data.plate_cost_minutes)
    await db.commit()
    return ProductSettings(plate_cost_minutes=await svc.read_plate_cost_minutes(db))


@router.get("/file-info/{library_file_id}", response_model=PlateFile)
async def plate_file_info(
    library_file_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _=ReadAccess,
    actor: User | ApiKeyActor | None = RequestActor,
):
    """What a file would bring as a plate: model, time, objects (to prefill the pieces)."""
    from backend.app.api.routes.print_queue import _assert_can_queue_library_file

    library_file = (
        await db.execute(LibraryFile.active().where(LibraryFile.id == library_file_id))
    ).scalar_one_or_none()
    if library_file is None:
        raise HTTPException(404, "Library file not found")
    _assert_can_queue_library_file(library_file, actor)
    return _file_info(library_file)


@router.post("", response_model=ProductDetail)
@router.post("/", response_model=ProductDetail)
async def create_product(
    data: ProductIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
):
    product = Product(name=data.name.strip(), created_by_id=actor.id if actor is not None else None)
    db.add(product)
    await db.flush()
    product = await svc.load_product(db, product.id)
    assert product is not None
    await _write_product(db, product, data, actor)
    await db.commit()
    return await _detail(db, await _get_product(db, product.id), estimates=False)


@router.get("/{product_id}", response_model=ProductDetail)
async def get_product(product_id: int, db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    product = await _get_product(db, product_id)
    # Catch up with the queue first (a print ended while nobody looked).
    await svc.refresh_product(db, product)
    await db.commit()
    return await _detail(db, await _get_product(db, product_id))


@router.put("/{product_id}", response_model=ProductDetail)
async def update_product(
    product_id: int,
    data: ProductIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
):
    product = await _get_product(db, product_id)
    await _write_product(db, product, data, actor)
    await db.commit()
    return await _detail(db, await _get_product(db, product_id), estimates=False)


@router.delete("/{product_id}")
async def delete_product(
    product_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Delete a product with no open orders; its waiting jobs leave the queue."""
    product = await _get_product(db, product_id)
    if await svc.open_orders(db, product.id):
        raise HTTPException(409, "The product has open orders; cancel them first")
    jobs = await svc.active_jobs(db, product.id)
    await svc.sync_jobs(db, jobs)
    if any(j.status == "printing" for j in jobs):
        raise HTTPException(409, "A print of this product is running; delete it when it is done")
    await svc._remove_waiting_jobs(db, jobs)
    await db.delete(product)
    await db.commit()
    return {"deleted": product_id}


@router.post("/{product_id}/orders", response_model=PlanOut)
async def create_order(
    product_id: int,
    data: OrderIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Add an order and plan the product's open orders again, this one with them."""
    await _get_product(db, product_id)
    db.add(
        ProductOrder(
            product_id=product_id,
            quantity=data.quantity,
            due_date=data.due_date,
            notes=data.notes,
            status="open",
            external_source=data.external_source,
            external_ref=data.external_ref,
            created_by_id=actor.id if actor is not None else None,
        )
    )
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "An order with this external reference already exists") from exc
    return await _plan_response(db, product_id, actor, review_required, printer_scope)


async def _get_order(db: AsyncSession, order_id: int) -> ProductOrder:
    order = await db.get(ProductOrder, order_id)
    if order is None:
        raise HTTPException(404, "Order not found")
    return order


@router.patch("/orders/{order_id}", response_model=PlanOut)
async def update_order(
    order_id: int,
    data: OrderUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    order = await _get_order(db, order_id)
    if order.status != "open":
        raise HTTPException(409, "Only an open order can be changed")
    fields = data.model_fields_set
    if data.quantity is not None:
        order.quantity = data.quantity
    if data.clear_due_date:
        order.due_date = None
    elif "due_date" in fields and data.due_date is not None:
        order.due_date = data.due_date
    if "notes" in fields:
        order.notes = data.notes
    await db.flush()
    return await _plan_response(db, order.product_id, actor, review_required, printer_scope)


@router.post("/orders/{order_id}/cancel", response_model=PlanOut)
async def cancel_order(
    order_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Cancel an open order; the plan drops what only it needed (printed parts stay in stock)."""
    order = await _get_order(db, order_id)
    if order.status != "open":
        raise HTTPException(409, "Only an open order can be cancelled")
    order.status = "cancelled"
    order.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.flush()
    return await _plan_response(db, order.product_id, actor, review_required, printer_scope)


@router.post("/{product_id}/replan", response_model=PlanOut)
async def replan_product(
    product_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Plan the open orders again: the planner's waiting jobs are replaced."""
    await _get_product(db, product_id)
    return await _plan_response(db, product_id, actor, review_required, printer_scope)


@router.post("/{product_id}/stock", response_model=PlanOut)
async def adjust_stock(
    product_id: int,
    data: StockIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Correct the pieces of a part in stock (a bad piece thrown away, pieces found), then replan."""
    product = await _get_product(db, product_id)
    if data.part_id not in {p.id for p in product.parts}:
        raise HTTPException(400, "The part is not a part of this product")
    db.add(
        ProductStockAdjustment(
            part_id=data.part_id,
            printer_id=data.printer_id or None,
            delta=data.delta,
            note=data.note,
            created_by_id=actor.id if actor is not None else None,
        )
    )
    await db.flush()
    return await _plan_response(db, product_id, actor, review_required, printer_scope)
