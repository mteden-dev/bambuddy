"""Products, orders for them, and the plan that prints them (fork).

How orders become queue jobs is in services/products.py and
services/product_planner.py.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
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
    require_media_token_ownership,
    require_ownership_permission,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.library import LibraryFile
from backend.app.models.printer import Printer
from backend.app.models.products import (
    Product,
    ProductJob,
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
    # Work after printing before the product is done (a tray glued into the
    # base drying): the planner prints such parts earlier.
    finish_minutes: int = Field(0, ge=0, le=7 * 24 * 60)


class PlatePieceIn(BaseModel):
    # The part as the index into the product's ``parts`` as sent, or by name.
    part: int | None = Field(None, ge=0)
    part_name: str | None = Field(None, min_length=1, max_length=255)
    pieces: int = Field(ge=1, le=1000)

    @model_validator(mode="after")
    def _one_part(self) -> PlatePieceIn:
        if (self.part is None) == (self.part_name is None):
            raise ValueError("Name the part by part (its index) or part_name, not both")
        return self


class PlateIn(BaseModel):
    library_file_id: int
    plate_id: int | None = Field(None, ge=1)
    pieces: list[PlatePieceIn] = Field(min_length=1, max_length=20)


class SkuRef(BaseModel):
    # A shop SKU (Base) that is this product; units: products one item is (a set of 3 -> 3).
    sku: str = Field(min_length=1, max_length=100)
    units: int = Field(1, ge=1, le=1000)


class ProductIn(IgnoresNullForRequiredColumns):
    # Replaces the product as a whole; a null name counts as not sent (a 422).
    __orm_table__ = "custom_products"

    name: str = Field(min_length=1, max_length=255)
    notes: str | None = Field(None, max_length=5000)
    parts: list[PartIn] = Field(min_length=1, max_length=20)
    plates: list[PlateIn] = Field(default_factory=list, max_length=100)
    # The product's shop SKUs; omitted leaves them as they are.
    skus: list[SkuRef] | None = Field(None, max_length=50)

    @model_validator(mode="after")
    def _pieces_name_parts(self) -> ProductIn:
        by_name = {part.name.strip().casefold(): index for index, part in enumerate(self.parts)}
        if len(by_name) < len(self.parts):
            raise ValueError("Two parts have the same name")
        for plate in self.plates:
            seen = set()
            for piece in plate.pieces:
                if piece.part_name is not None:
                    index = by_name.get(piece.part_name.strip().casefold())
                    if index is None:
                        raise ValueError(f"A plate names part {piece.part_name!r}, which the product does not have")
                    piece.part, piece.part_name = index, None
                assert piece.part is not None
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


class PlatePieceRef(BaseModel):
    # The part by id, or by name (case does not matter).
    part_id: int | None = None
    part_name: str | None = Field(None, min_length=1, max_length=255)
    pieces: int = Field(ge=1, le=1000)

    @model_validator(mode="after")
    def _one_part(self) -> PlatePieceRef:
        if (self.part_id is None) == (self.part_name is None):
            raise ValueError("Name the part by part_id or part_name, not both")
        return self


class PlateAdd(BaseModel):
    library_file_id: int
    plate_id: int | None = Field(None, ge=1)
    pieces: list[PlatePieceRef] = Field(min_length=1, max_length=20)


class PlatesAdd(BaseModel):
    # A file (and plate) the product already has gets these pieces instead.
    plates: list[PlateAdd] = Field(min_length=1, max_length=200)


class PlateSuggestIn(BaseModel):
    # Where to look: a folder (with its subfolders unless recursive is false),
    # or files by id; at least one.
    folder_id: int | None = None
    recursive: bool = True
    library_file_ids: list[int] | None = Field(None, max_length=1000)
    # Part name -> more words that name it in file names, e.g. {"Góra": ["top", "lid"]}.
    keywords: dict[str, list[str]] = Field(default_factory=dict)
    # Add the suggestions that found pieces, skipping files the product has.
    apply: bool = False

    @model_validator(mode="after")
    def _somewhere(self) -> PlateSuggestIn:
        if self.folder_id is None and not self.library_file_ids:
            raise ValueError("Give folder_id or library_file_ids")
        return self


class StockMoveIn(BaseModel):
    part_id: int
    # 0 or null: pieces whose printer is not known.
    from_printer_id: int | None = None
    to_printer_id: int | None = None
    pieces: int = Field(ge=1, le=10000)
    note: str | None = Field(None, max_length=255)


class ProductSettings(IgnoresNullForRequiredColumns):
    # Stored in one settings row, so no column says it can't be null; the field
    # is required, and a null is a 422.
    __orm_table__ = "settings"

    # What one more plate costs, as minutes of waiting: work, a plate change.
    plate_cost_minutes: int = Field(ge=0, le=svc.MAX_PLATE_COST_MINUTES)
    # A preferred printer loses only to one done this much sooner: the larger
    # of the minutes and the share of the plate's print time. Left out: unchanged.
    prefer_margin_minutes: int | None = Field(None, ge=0, le=svc.MAX_PREFER_MINUTES)
    prefer_margin_pct: int | None = Field(None, ge=0, le=100)
    # Loading a spool or changing one that runs out, once someone is there.
    filament_swap_minutes: int | None = Field(None, ge=0, le=svc.MAX_SWAP_MINUTES)
    # The planner's jobs ask for their files' colours ("force colour match").
    force_color: bool | None = None
    # Plates printed by hand count (stock, orders) from now on. Left out: unchanged.
    hand_prints_count: bool | None = None


# --- responses -------------------------------------------------------------------


class PartPieces(BaseModel):
    part_id: int
    pieces: int


class ProductSettingsOut(BaseModel):
    plate_cost_minutes: int
    prefer_margin_minutes: int = svc.DEFAULT_PREFER_MINUTES
    prefer_margin_pct: int = svc.DEFAULT_PREFER_PCT
    filament_swap_minutes: int = svc.DEFAULT_SWAP_MINUTES
    force_color: bool = True
    hand_prints_count: bool = False
    # "Shortest first" is on: the scheduler takes jobs by print time, not in
    # the order the plan put them (pinned and reserved jobs keep their printer).
    sjf_enabled: bool = False


class PlateSuggestion(BaseModel):
    file: PlateFile
    # Empty when the name says nothing usable.
    pieces: list[PartPieces]
    # "single_part" or "name"; None when nothing was found.
    found_by: str | None
    # The product has this file already.
    added: bool


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
    finish_minutes: int = 0


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
    skus: list[SkuRef] = Field(default_factory=list)
    open_orders: int = 0
    open_units: int = 0
    # GET /products/{id}/thumbnail answers: the uploaded picture, else the
    # first plate's. thumbnail_version changes with it (for caches).
    has_thumbnail: bool = False
    custom_thumbnail: bool = False
    thumbnail_version: str | None = None
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
    # The user's, kept as it is by a plan: queued by hand (a plate's file
    # printed outside the planner), or moved by hand to another printer.
    by_hand: bool = False
    moved: bool = False
    # Its pieces count (stock, orders); not for a plate printed by hand while such prints do not count.
    counted: bool = True


class ProductDetail(ProductOut):
    stock: list[StockOut] = Field(default_factory=list)
    orders: list[OrderOut] = Field(default_factory=list)
    jobs: list[JobOut] = Field(default_factory=list)
    # Pieces the open orders still need that no job in the queue will make
    # (a planner job someone deleted): replanning puts them back.
    unplanned: list[PartPieces] = Field(default_factory=list)


class PlanOut(BaseModel):
    product: ProductDetail
    # Plates in the queue for the plan: new jobs, waiting jobs it kept and ones kept as moved or queued by hand.
    planned_jobs: int
    created: int = 0
    kept: int = 0
    # Waiting jobs it took out of the queue.
    replaced: int
    # Waiting jobs queued or moved by hand that it kept as they are (counted in planned_jobs).
    held: int = 0
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
        "parts": [
            PartOut(id=p.id, name=p.name, quantity=p.quantity, matched=p.matched, finish_minutes=p.finish_minutes or 0)
            for p in product.parts
        ],
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
        "skus": [SkuRef(sku=row.sku, units=row.units) for row in product.skus],
        "open_orders": counts[0],
        "open_units": counts[1],
        "has_thumbnail": svc.has_thumbnail(product),
        "custom_thumbnail": bool(product.thumbnail_path),
        "thumbnail_version": svc.thumbnail_version(product),
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
    placed_on, moved = await svc.placed_by_hand(db, jobs_rows)
    plates = {plate.id: plate for plate in product.plates}
    jobs = []
    coming = {part_id: dict(by_printer) for part_id, by_printer in pool.items()}
    for job in jobs_rows:
        pieces = svc.job_pieces(job, part_ids)
        planner.pool_add(coming, svc.piece_printer(job), svc.counted_pieces(job, part_ids))
        plate = plates.get(job.product_plate_id or -1)
        printer_id = placed_on.get(job.id, job.printer_id)
        jobs.append(
            JobOut(
                id=job.id,
                queue_item_id=job.queue_item_id,
                status=job.status,
                printer_id=printer_id,
                printer_name=printer_names.get(printer_id),
                by_hand=bool(job.by_hand),
                moved=job.id in moved,
                counted=job.counted is not False,
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


async def _check_plate_files(db: AsyncSession, file_ids: set[int], actor: User | ApiKeyActor | None) -> None:
    """Every file exists, the caller may print it, and it says which printer it is for."""
    from backend.app.api.routes.print_queue import _assert_can_queue_library_file

    files = {}
    if file_ids:
        rows = (await db.execute(LibraryFile.active().where(LibraryFile.id.in_(file_ids)))).scalars()
        files = {f.id: f for f in rows}
    for file_id in sorted(file_ids):
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


async def _set_plate(
    db: AsyncSession, product: Product, library_file_id: int, plate_id: int | None, pieces: dict[int, int]
) -> ProductPlate:
    """The product's plate for this file (and plate), new or with these pieces now. The caller commits."""
    row = next((p for p in product.plates if p.library_file_id == library_file_id and p.plate_id == plate_id), None)
    if row is None:
        row = ProductPlate(
            product_id=product.id,
            library_file_id=library_file_id,
            plate_id=plate_id,
            sort_order=max((p.sort_order for p in product.plates), default=-1) + 1,
        )
        db.add(row)
        await db.flush()
        product.plates.append(row)
    else:
        for piece in list(row.pieces):
            await db.delete(piece)
        await db.flush()
    for part_id, n in pieces.items():
        db.add(ProductPlatePart(plate_id=row.id, part_id=part_id, pieces=n))
    return row


async def _write_skus(db: AsyncSession, product: Product, skus: list[SkuRef]) -> None:
    """Make ``skus`` the product's SKUs. A SKU another product has is refused (409);
    one marked "not printed" is taken over."""
    from backend.app.models.base_sync import ProductSku

    wanted = {ref.sku.strip(): ref.units for ref in skus}
    folded = {sku.casefold() for sku in wanted}
    if len(folded) < len(wanted):
        raise HTTPException(400, "The same SKU twice")
    rows = (await db.execute(select(ProductSku).where(func.lower(ProductSku.sku).in_(folded)))).scalars()
    taken = {row.sku.casefold(): row for row in rows}
    for sku in wanted:
        row = taken.get(sku.casefold())
        if row is not None and row.product_id not in (None, product.id):
            owner = await db.get(Product, row.product_id)
            raise HTTPException(409, f"SKU {sku} is product {owner.name if owner else row.product_id} already")
    for row in list(product.skus):
        if row.sku.casefold() not in folded:
            product.skus.remove(row)
            await db.delete(row)
    for sku, units in wanted.items():
        row = taken.get(sku.casefold())
        if row is None:
            row = ProductSku(sku=sku, product_id=product.id, units=units)
            db.add(row)
            product.skus.append(row)
        else:
            row.product_id = product.id
            row.units = units
    await db.flush()


async def _write_product(db: AsyncSession, product: Product, data: ProductIn, actor: User | ApiKeyActor | None) -> None:
    """Apply ``data`` to ``product``: parts by id, plates by file. The caller commits.

    A plate whose file (and plate) the product had keeps its row, so the
    planner's waiting jobs for it can stay in the queue.
    """
    existing = {p.id: p for p in product.parts}
    for part in data.parts:
        if part.id is not None and part.id not in existing:
            raise HTTPException(400, f"Part {part.id} is not a part of this product")
    await _check_plate_files(db, {plate.library_file_id for plate in data.plates}, actor)
    if data.skus is not None:
        await _write_skus(db, product, data.skus)

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
        row.finish_minutes = part.finish_minutes
        row.sort_order = index
        parts.append(row)
    await db.flush()
    wanted = {(plate.library_file_id, plate.plate_id) for plate in data.plates}
    for plate in list(product.plates):
        if (plate.library_file_id, plate.plate_id) not in wanted:
            product.plates.remove(plate)
            await db.delete(plate)
    await db.flush()
    for index, plate in enumerate(data.plates):
        pieces: dict[int, int] = {}
        for piece in plate.pieces:
            assert piece.part is not None  # names were turned into indexes
            pieces[parts[piece.part].id] = piece.pieces
        row = await _set_plate(db, product, plate.library_file_id, plate.plate_id, pieces)
        row.sort_order = index
    await db.flush()


async def _follow_base_orders(db: AsyncSession, data: ProductIn) -> None:
    """New or changed SKUs: accepted Base orders still waiting get their product orders, then replan."""
    if not data.skus:
        return
    from backend.app.services import base_sync

    changed = await base_sync.refresh_accepted(db)
    if changed:
        await base_sync.replan_products(db, changed, await base_sync.read_config(db))


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
    logger.info(
        "[PRODUCTS] Planned product %s: %s plates (%s kept), %s replaced",
        product_id,
        len(plates),
        outcome.kept,
        outcome.replaced,
    )
    return PlanOut(
        product=await _detail(db, product),
        planned_jobs=len(outcome.item_ids) + outcome.kept + outcome.held,
        created=len(outcome.item_ids),
        kept=outcome.kept,
        replaced=outcome.replaced,
        held=outcome.held,
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


async def _settings_out(db: AsyncSession) -> ProductSettingsOut:
    from backend.app.api.routes.settings import get_setting

    sjf = (await get_setting(db, "queue_shortest_first") or "").lower() == "true"
    plan = await svc.read_plan_settings(db)
    return ProductSettingsOut(
        plate_cost_minutes=await svc.read_plate_cost_minutes(db),
        prefer_margin_minutes=plan.prefer_minutes,
        prefer_margin_pct=plan.prefer_pct,
        filament_swap_minutes=plan.swap_minutes,
        force_color=plan.force_color,
        hand_prints_count=plan.hand_prints_count,
        sjf_enabled=sjf,
    )


@router.get("/settings", response_model=ProductSettingsOut)
async def get_product_settings(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    return await _settings_out(db)


@router.put("/settings", response_model=ProductSettingsOut)
async def put_product_settings(
    data: ProductSettings,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    await svc.write_plate_cost_minutes(db, data.plate_cost_minutes)
    await svc.write_plan_settings(
        db,
        prefer_minutes=data.prefer_margin_minutes,
        prefer_pct=data.prefer_margin_pct,
        swap_minutes=data.filament_swap_minutes,
        force_color=data.force_color,
        hand_prints_count=data.hand_prints_count,
    )
    await db.commit()
    return await _settings_out(db)


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


# --- which orders a job prints for -----------------------------------------------------------


class OrderTagOut(BaseModel):
    product_order_id: int
    # An Allegro nick, else the shop's order number (or the order's notes).
    label: str
    # Shown on hover: the Base order id and where it came from.
    title: str
    base_order_id: int | None = None
    # "allegro" or "shop" for an order from Base; None for one entered by hand.
    source_kind: str | None = None
    ship_by: UTCDatetime = None
    due: UTCDatetime = None


class JobOrdersOut(BaseModel):
    orders: list[OrderTagOut]
    # Its pieces go to no open order: it prints for stock.
    for_stock: bool = False


class OrderTagsOut(BaseModel):
    # queue job id -> the orders it prints for (waiting and printing jobs).
    items: dict[int, JobOrdersOut]
    # printer id -> the orders of what it prints now.
    printers: dict[int, JobOrdersOut]


@router.get("/order-tags", response_model=OrderTagsOut)
async def order_tags(db: AsyncSession = Depends(get_db, scope="function"), _=ReadAccess):
    """Which orders the planner's waiting and printing jobs print for, to label them in the queue,
    on the timeline and on the printer cards. Stock goes to the orders first, then the jobs in the
    order they print, soonest due first; one plate may serve several orders.
    """
    items, printers = await svc.order_tags(db)

    def out(entry) -> JobOrdersOut:
        return JobOrdersOut(
            orders=[
                OrderTagOut(**{**t.__dict__, "ship_by": _utc(t.ship_by), "due": _utc(t.due)}) for t in entry.orders
            ],
            for_stock=entry.for_stock,
        )

    return OrderTagsOut(
        items={k: out(v) for k, v in items.items()},
        printers={k: out(v) for k, v in printers.items()},
    )


# --- cancelling an order's print in the queue ---------------------------------------------


class QueueJobCancelIn(BaseModel):
    # What becomes of the pieces the job was to print: "replan" plans them again
    # (the print comes back, maybe on another printer or plate), "stock" puts
    # them in stock as on hand, "withdraw" takes ``orders`` out of production.
    then: Literal["replan", "stock", "withdraw"]
    # withdraw: product order ids, as GET /products/order-tags lists them for
    # the job; a Base order is withdrawn whole.
    orders: list[int] = Field(default_factory=list, max_length=100)


class QueueJobCancelOut(BaseModel):
    # Products planned again, and the queue jobs the plans made and kept.
    replanned: list[int]
    created: int = 0
    kept: int = 0
    # stock: the pieces put in stock.
    stocked: list[PartPieces] = Field(default_factory=list)
    # withdraw: the product orders taken out, and the Base orders among them.
    withdrawn: list[int] = Field(default_factory=list)
    withdrawn_base_orders: list[int] = Field(default_factory=list)
    # Pieces the open orders still need that no plate can make.
    short: list[PartPieces] = Field(default_factory=list)


@router.post("/queue-items/{item_id}/cancel", response_model=QueueJobCancelOut)
async def cancel_queue_job(
    item_id: int,
    data: QueueJobCancelIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    auth_result: tuple[User | ApiKeyActor | None, bool] = Depends(
        require_ownership_permission(Permission.QUEUE_UPDATE_ALL, Permission.QUEUE_UPDATE_OWN)
    ),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Cancel a waiting queue job the planner made for orders, and say what becomes of its pieces.

    A plain cancel (POST /queue/{id}/cancel) leaves the orders short with
    nothing in the queue to make up for it, until something else replans the
    product. Here the job is cancelled and then, by ``then``: the product is
    planned again (``replan``), its pieces go into stock as pieces of no known
    printer first (``stock``: someone has them), or ``orders`` are withdrawn
    first (``withdraw``: a Base order whole, as its Withdraw does). Each product
    changed is planned again, which also shrinks or drops a plate other orders
    shared.
    """
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.services.finance_budget import release_budget_reservation
    from backend.app.services.print_scheduler import scheduler

    user, can_modify_all = auth_result
    item = await db.get(PrintQueueItem, item_id)
    if item is None or not printer_scope.allows(item.printer_id):
        raise HTTPException(404, "Queue item not found")
    if not can_modify_all and item.created_by_id != user.id:
        raise HTTPException(403, "You can only cancel your own queue items")
    if item.status != "pending" or item.dispatching_at is not None:
        raise HTTPException(409, "Only a waiting job can be cancelled here; stop a printing one")
    job = await svc.job_of_item(db, item)
    if job is None:
        raise HTTPException(409, "The planner did not make this job for an order")
    if data.then == "withdraw" and not data.orders:
        raise HTTPException(400, "Say which orders to withdraw")
    product = await svc.load_product(db, job.product_id)
    part_ids = {p.id for p in product.parts} if product is not None else set()

    item.status = "cancelled"
    item.completed_at = datetime.now(timezone.utc)
    await release_budget_reservation(db, source_type="print_queue", source_id=item.id, status="released")
    await db.flush()
    # The job follows its queue job now, not at the next plan.
    await svc.after_queue_items_changed(db, [item.id])

    actor_id = actor.id if actor is not None else None
    changed = {job.product_id}
    out = QueueJobCancelOut(replanned=[])
    if data.then == "stock":
        stocked = svc.put_pieces_in_stock(db, job, part_ids, actor_id=actor_id, note=f"Queue job {item.id}: on hand")
        out.stocked = [PartPieces(part_id=k, pieces=n) for k, n in stocked]
    elif data.then == "withdraw":
        withdrawal = await svc.withdraw_orders(db, data.orders)
        changed |= withdrawal.products
        out.withdrawn = withdrawal.orders
        out.withdrawn_base_orders = withdrawal.base_orders
    await db.flush()

    created: list[int] = []
    short: dict[int, int] = {}
    for product_id in sorted(changed):
        outcome = await svc.replan(
            db,
            product_id,
            actor_id=actor_id,
            manual_start=review_required or bool(item.manual_start),
            printer_ids=printer_scope.printer_ids,
        )
        created += outcome.item_ids
        out.kept += outcome.kept
        if outcome.plan is not None:
            for part_id, n in outcome.plan.short.items():
                short[part_id] = short.get(part_id, 0) + n
        out.replanned.append(product_id)
    await db.commit()
    await svc.announce_planned(created)
    scheduler.notify_dispatch_cancelled(item_id)
    out.created = len(created)
    out.short = [PartPieces(part_id=k, pieces=n) for k, n in sorted(short.items()) if n > 0]
    logger.info(
        "[PRODUCTS] Cancelled queue job %s (%s): replanned %s, %s new, %s kept",
        item_id,
        data.then,
        out.replanned,
        out.created,
        out.kept,
    )
    return out


# --- checking finished pieces ------------------------------------------------------------


class QcPiece(BaseModel):
    part_id: int
    part_name: str
    pieces: int
    rejected: int = 0


class QcJobOut(BaseModel):
    id: int
    product_id: int
    product_name: str
    printer_id: int | None
    printer_name: str | None
    library_file_id: int | None = None
    filename: str | None = None
    archive_id: int | None = None
    finished_at: UTCDatetime = None
    checked_at: UTCDatetime = None
    pieces: list[QcPiece]
    # Queued by hand (no order brings its bad pieces back by itself).
    by_hand: bool = False
    # Its plate queued again from the check: how that print is doing.
    reprint: Literal["waiting", "printing", "done"] | None = None


class QcCheckIn(BaseModel):
    # Bad pieces per part; none (or an empty list) means all good.
    rejected: list[PartPieces] = Field(default_factory=list, max_length=20)
    # Where it was answered, kept with the verdict in the archive.
    source: Literal["dialog", "plate_clear"] = "dialog"
    # With bad pieces: print the plate again, first in the queue or last.
    # Ignored while a reprint from an earlier check still waits or prints.
    reprint: Literal["end", "asap"] | None = None


class QcCheckOut(BaseModel):
    job: QcJobOut
    # Bad pieces or a reopened order: the product was planned again.
    replanned: bool
    reopened_orders: list[int] = Field(default_factory=list)
    # The queue job printing the plate again (``reprint`` asked for).
    reprint_item_id: int | None = None


async def _qc_out(db: AsyncSession, jobs: list[ProductJob]) -> list[QcJobOut]:
    products: dict[int, Product] = {}
    for product_id in {job.product_id for job in jobs}:
        product = await svc.load_product(db, product_id)
        if product is not None:
            products[product_id] = product
    printer_names = dict((await db.execute(select(Printer.id, Printer.name))).all())
    reprints = await svc.reprints_of(db, [job.id for job in jobs])
    reprint_state = {"planned": "waiting", "printing": "printing", "done": "done"}
    result = []
    for job in jobs:
        product = products.get(job.product_id)
        if product is None:
            continue
        reprint = reprints.get(job.id)
        names = {part.id: part.name for part in product.parts}
        plate = next((pl for pl in product.plates if pl.id == job.product_plate_id), None)
        bad = svc.rejected_pieces(job)
        result.append(
            QcJobOut(
                id=job.id,
                product_id=product.id,
                product_name=product.name,
                printer_id=job.printer_id,
                printer_name=printer_names.get(job.printer_id),
                library_file_id=plate.library_file_id if plate is not None else None,
                filename=plate.library_file.filename if plate is not None and plate.library_file else None,
                archive_id=job.archive_id,
                finished_at=job.finished_at,
                checked_at=job.checked_at,
                pieces=[
                    QcPiece(part_id=pid, part_name=names[pid], pieces=n, rejected=bad.get(pid, 0))
                    for pid, n in svc.job_pieces(job, set(names))
                ],
                by_hand=bool(job.by_hand),
                reprint=reprint_state.get(reprint.status) if reprint is not None else None,
            )
        )
    return result


@router.get("/qc", response_model=list[QcJobOut])
async def jobs_to_check(
    printer_id: int | None = None,
    checked: bool = False,
    on_plate: bool = False,
    db: AsyncSession = Depends(get_db, scope="function"),
    _=ReadAccess,
):
    """Finished product jobs nobody has checked yet (last 7 days), newest first; ``printer_id`` filters.

    Their pieces count as good until someone says otherwise. ``checked``: the
    ones checked in those 7 days instead (to correct an answer). ``on_plate``
    (with ``printer_id``): only the job on the printer's plate now, the one
    the question at plate clear is about.
    """
    return await _qc_out(db, await svc.jobs_to_check(db, printer_id, checked=checked, on_plate=on_plate))


@router.post("/jobs/{job_id}/check", response_model=QcCheckOut)
async def check_job(
    job_id: int,
    data: QcCheckIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Say a finished job's pieces were checked, and how many of each part were bad.

    Bad pieces leave stock and the product is planned again, so they are
    printed anew for the orders that need them; an order already closed with
    one of them opens again. Pieces no order needs (a plate printed by hand)
    come back only with ``reprint``: the plate is queued again, first or last.
    Checking again replaces the earlier answer; all good takes a reprint that
    has not started out of the queue.
    """
    job = await db.get(ProductJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    actor_id = actor.id if actor is not None else None
    try:
        reopened = await svc.check_job(db, job, {r.part_id: r.pieces for r in data.rejected}, source=data.source)
        bad = bool(svc.rejected_pieces(job))
        removed = 0
        reprint_item_id: int | None = None
        if not bad:
            removed = await svc.remove_waiting_reprints(db, job)
        elif data.reprint is not None and await svc.live_reprint(db, job) is None:
            reprint = await svc.reprint_job(
                db, job, asap=data.reprint == "asap", actor_id=actor_id, manual_start=review_required
            )
            printer_scope.ensure(reprint.printer_id)
            reprint_item_id = reprint.queue_item_id
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    replan = bool(reopened) or bad or bool(removed)
    item_ids: list[int] = [reprint_item_id] if reprint_item_id is not None else []
    if replan:
        outcome = await svc.replan(
            db,
            job.product_id,
            actor_id=actor_id,
            manual_start=review_required,
            printer_ids=printer_scope.printer_ids,
        )
        item_ids += outcome.item_ids
    await db.commit()
    if item_ids:
        await svc.announce_planned(item_ids)
    [out] = await _qc_out(db, [await db.get(ProductJob, job_id)])
    return QcCheckOut(
        job=out, replanned=replan, reopened_orders=[o.id for o in reopened], reprint_item_id=reprint_item_id
    )


@router.post("/jobs/{job_id}/uncheck", response_model=QcCheckOut)
async def uncheck_job(
    job_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Take a check back (undo): the job waits to be checked again; bad pieces it had count again.

    A reprint queued from the check that has not started leaves the queue.
    """
    job = await db.get(ProductJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    had_bad = await svc.uncheck_job(db, job)
    item_ids: list[int] = []
    if had_bad:
        outcome = await svc.replan(
            db,
            job.product_id,
            actor_id=actor.id if actor is not None else None,
            manual_start=review_required,
            printer_ids=printer_scope.printer_ids,
        )
        item_ids = outcome.item_ids
    await db.commit()
    if item_ids:
        await svc.announce_planned(item_ids)
    [out] = await _qc_out(db, [await db.get(ProductJob, job_id)])
    return QcCheckOut(job=out, replanned=had_bad)


class PreferenceIn(BaseModel):
    # None leaves the choice to the plan ("Automatic").
    printer_id: int | None = None


@router.put("/jobs/{job_id}/preference", response_model=PlanOut)
async def set_job_preference(
    job_id: int,
    data: PreferenceIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Prefer a printer for a waiting plate of the plan's (or none: "Automatic"), then replan its product.

    A nudge, not a pin: the plan keeps the plate there unless another printer
    is done much sooner or needs no spool swapped for it where the preferred
    one does (services/product_planner.py). The plate printing it after the
    replan carries the preference, also through later replans.
    """
    from backend.app.services import base_sync

    job = await db.get(ProductJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "planned" or job.by_hand or job.queue_item_id is None:
        raise HTTPException(409, "Only a waiting plate of the plan takes a preferred printer")
    if not await svc.waiting_jobs(db, [job]):
        raise HTTPException(409, "The plate is being sent to a printer already")
    _, moved = await svc.placed_by_hand(db, [job])
    if job.id in moved:
        raise HTTPException(409, "The plate was moved by hand: it stays where it was put")
    if data.printer_id is not None:
        printer = await db.get(Printer, data.printer_id)
        if printer is None or not printer.is_active:
            raise HTTPException(400, "No such enabled printer")
        plate = await db.get(ProductPlate, job.product_plate_id) if job.product_plate_id is not None else None
        library_file = await db.get(LibraryFile, plate.library_file_id) if plate is not None else None
        model = svc.model_key(svc.plate_model(library_file)) if library_file is not None else ""
        if not model or svc.model_key(printer.model) != model:
            raise HTTPException(400, "The printer is not of the model the plate is sliced for")
    job.preferred_printer_id = data.printer_id
    await db.flush()
    # A plan for Base orders makes jobs that wait for Start when the Base settings say so.
    open_orders = await svc.open_orders(db, job.product_id)
    manual_start = review_required or (
        any(o.external_source == base_sync.EXTERNAL_SOURCE for o in open_orders)
        and (await base_sync.read_config(db)).manual_start
    )
    logger.info("[PRODUCTS] Job %s: preferred printer %s", job_id, data.printer_id)
    return await _plan_response(db, job.product_id, actor, manual_start, printer_scope)


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
    await _follow_base_orders(db, data)
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
    await _follow_base_orders(db, data)
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
    svc.remove_thumbnail(product)
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


class ReplanAllOut(BaseModel):
    # Products planned again (open orders, or waiting jobs to take out).
    products: int
    created: int = 0
    kept: int = 0
    replaced: int = 0
    held: int = 0
    # Products whose plan failed; the others are planned.
    failed: list[int] = Field(default_factory=list)


@router.post("/replan", response_model=ReplanAllOut)
async def replan_all(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Plan every product's open orders again, the soonest due first (the timeline's "replan the queue").

    Each product is planned as ``POST /{id}/replan`` plans it and committed on
    its own, so one that fails leaves the others planned.
    """
    out = ReplanAllOut(products=0)
    for product_id in await svc.products_to_replan(db):
        try:
            outcome = await svc.replan(
                db,
                product_id,
                actor_id=actor.id if actor is not None else None,
                manual_start=review_required,
                printer_ids=printer_scope.printer_ids,
            )
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("[PRODUCTS] Could not replan product %s with the whole queue", product_id)
            out.failed.append(product_id)
            continue
        await svc.announce_planned(outcome.item_ids)
        out.products += 1
        out.created += len(outcome.item_ids)
        out.kept += outcome.kept
        out.replaced += outcome.replaced
        out.held += outcome.held
    logger.info(
        "[PRODUCTS] Replanned the queue: %s products, %s new jobs, %s kept, %s replaced, failed %s",
        out.products,
        out.created,
        out.kept,
        out.replaced,
        out.failed,
    )
    return out


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


# --- plates ---------------------------------------------------------------------------------


def _resolve_pieces(product: Product, refs: list[PlatePieceRef]) -> dict[int, int]:
    by_id = {p.id: p for p in product.parts}
    by_name = {p.name.strip().casefold(): p for p in product.parts}
    pieces: dict[int, int] = {}
    for ref in refs:
        if ref.part_id is not None:
            part = by_id.get(ref.part_id)
            if part is None:
                raise HTTPException(400, f"Part {ref.part_id} is not a part of this product")
        else:
            assert ref.part_name is not None
            part = by_name.get(ref.part_name.strip().casefold())
            if part is None:
                raise HTTPException(400, f"The product has no part named {ref.part_name!r}")
        if part.id in pieces:
            raise HTTPException(400, f"A plate names {part.name!r} twice")
        pieces[part.id] = ref.pieces
    return pieces


@router.post("/{product_id}/plates", response_model=ProductDetail)
async def add_plates(
    product_id: int,
    data: PlatesAdd,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """Add plates to a product (parts by id or name); a file it has gets the new pieces.

    Open orders are not replanned: POST /products/{id}/replan when they should
    use the new plates.
    """
    product = await _get_product(db, product_id)
    await _check_plate_files(db, {plate.library_file_id for plate in data.plates}, actor)
    resolved = [(plate, _resolve_pieces(product, plate.pieces)) for plate in data.plates]
    for plate, pieces in resolved:
        await _set_plate(db, product, plate.library_file_id, plate.plate_id, pieces)
    await db.commit()
    return await _detail(db, await _get_product(db, product_id), estimates=False)


@router.delete("/{product_id}/plates/{plate_id}", response_model=ProductDetail)
async def delete_plate(
    product_id: int,
    plate_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Take a plate off a product (by its id in the product's ``plates``)."""
    product = await _get_product(db, product_id)
    plate = next((p for p in product.plates if p.id == plate_id), None)
    if plate is None:
        raise HTTPException(404, "The product has no such plate")
    await db.delete(plate)
    await db.commit()
    return await _detail(db, await _get_product(db, product_id), estimates=False)


@router.post("/{product_id}/plates/suggest")
async def suggest_plates(
    product_id: int,
    data: PlateSuggestIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
) -> dict:
    """Which sliced files in a folder (or by id) print which parts, from their names.

    Every sliced file that says which printer it is for is listed, with the
    pieces its name and objects suggest (see services/products.guess_plate),
    so this also lists a folder's plates for a script to assign itself. With
    ``apply`` the suggestions with pieces are added (files the product has
    are left alone).
    """
    from backend.app.core.permissions import Permission as P

    product = await _get_product(db, product_id)
    query = LibraryFile.active()
    if data.library_file_ids:
        query = query.where(LibraryFile.id.in_(data.library_file_ids))
    if data.folder_id is not None:
        folders = await svc.folder_and_below(db, data.folder_id) if data.recursive else {data.folder_id}
        query = query.where(LibraryFile.folder_id.in_(folders))
    files = list((await db.execute(query.order_by(LibraryFile.filename))).scalars())
    can_read_all = actor is None or actor.has_permission(P.LIBRARY_READ_ALL.value)
    files = [
        f
        for f in files
        if svc.is_sliced_file(f)
        and svc.plate_model(f)
        and (can_read_all or (f.created_by_id is not None and f.created_by_id == actor.id))
    ]
    have = {(p.library_file_id, p.plate_id) for p in product.plates}
    suggestions = []
    applied = 0
    for library_file in files:
        guess = svc.guess_plate(list(product.parts), library_file, data.keywords)
        added = (library_file.id, None) in have
        if data.apply and guess.pieces and not added:
            await _set_plate(db, product, library_file.id, None, guess.pieces)
            applied += 1
            added = True
        suggestions.append(
            PlateSuggestion(
                file=_file_info(library_file),
                pieces=[PartPieces(part_id=k, pieces=v) for k, v in guess.pieces.items()],
                found_by=guess.found_by,
                added=added,
            )
        )
    if applied:
        await db.commit()
    return {"suggestions": [s.model_dump() for s in suggestions], "applied": applied}


# --- thumbnail ------------------------------------------------------------------------------


@router.get("/{product_id}/thumbnail")
async def get_thumbnail(
    product_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _=Depends(require_media_token_ownership(Permission.QUEUE_READ_ALL, Permission.QUEUE_READ_OWN)),
):
    """The product's picture: the uploaded one, else its first plate's thumbnail.

    Accepts a media token in ``?token=`` because <img> cannot send headers.
    """
    path = svc.thumbnail_file(await _get_product(db, product_id))
    if path is None:
        raise HTTPException(404, "The product has no picture")
    media = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    return FileResponse(path, media_type=media.get(path.suffix.lower(), "image/png"))


@router.post("/{product_id}/thumbnail", response_model=ProductDetail)
async def upload_thumbnail(
    product_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Upload the product's picture (PNG, JPEG, WebP…; stored as a PNG of at most 512 px)."""
    product = await _get_product(db, product_id)
    data = await file.read(svc.THUMBNAIL_MAX_BYTES + 1)
    try:
        svc.save_thumbnail(product, data)
    except svc.ThumbnailError as exc:
        raise HTTPException(400, str(exc)) from exc
    await db.commit()
    return await _detail(db, await _get_product(db, product_id), estimates=False)


@router.post("/{product_id}/thumbnail/from-file/{library_file_id}", response_model=ProductDetail)
async def thumbnail_from_file(
    product_id: int,
    library_file_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """Use a library file's thumbnail (any file, e.g. a photo uploaded to File Manager) as the picture."""
    from backend.app.api.routes.print_queue import _assert_can_queue_library_file

    product = await _get_product(db, product_id)
    library_file = (
        await db.execute(LibraryFile.active().where(LibraryFile.id == library_file_id))
    ).scalar_one_or_none()
    if library_file is None:
        raise HTTPException(404, "Library file not found")
    _assert_can_queue_library_file(library_file, actor)
    source = svc._absolute(library_file.thumbnail_path)
    if source is None or not source.is_file():
        raise HTTPException(404, "The file has no thumbnail")
    try:
        svc.save_thumbnail(product, source.read_bytes())
    except svc.ThumbnailError as exc:
        raise HTTPException(400, str(exc)) from exc
    await db.commit()
    return await _detail(db, await _get_product(db, product_id), estimates=False)


@router.delete("/{product_id}/thumbnail", response_model=ProductDetail)
async def delete_thumbnail(
    product_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Drop the uploaded picture; the product shows its first plate's thumbnail again."""
    product = await _get_product(db, product_id)
    svc.remove_thumbnail(product)
    await db.commit()
    return await _detail(db, await _get_product(db, product_id), estimates=False)


# --- moving pieces between printers ------------------------------------------------------------


@router.post("/{product_id}/stock/move", response_model=PlanOut)
async def move_stock(
    product_id: int,
    data: StockMoveIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
    actor: User | ApiKeyActor | None = RequestActor,
    review_required: bool = QueueReviewRequired,
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Count pieces of a part as made on another printer, then replan.

    For pairing on purpose what the planner keeps apart: a lid from one
    printer with a base from another makes a product once both count on
    one printer.
    """
    product = await _get_product(db, product_id)
    part = next((p for p in product.parts if p.id == data.part_id), None)
    if part is None:
        raise HTTPException(400, "The part is not a part of this product")
    source = data.from_printer_id or planner.UNKNOWN_PRINTER
    target = data.to_printer_id or planner.UNKNOWN_PRINTER
    if source == target:
        raise HTTPException(400, "The pieces are on that printer already")
    there = (await svc.stock_pool(db, product)).get(part.id, {}).get(source, 0)
    if there < data.pieces:
        raise HTTPException(400, f"Only {max(0, there)} pieces of {part.name} are counted on that printer")
    note = data.note or "moved"
    actor_id = actor.id if actor is not None else None
    db.add(
        ProductStockAdjustment(
            part_id=part.id, printer_id=source or None, delta=-data.pieces, note=note, created_by_id=actor_id
        )
    )
    db.add(
        ProductStockAdjustment(
            part_id=part.id, printer_id=target or None, delta=data.pieces, note=note, created_by_id=actor_id
        )
    )
    await db.flush()
    return await _plan_response(db, product_id, actor, review_required, printer_scope)
