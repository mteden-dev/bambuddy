"""Products, their orders and the queue jobs that print them (fork).

A product is parts; its plates are sliced files that print pieces of them
(models/products.py). An order wants some products. The planner
(services/product_planner.py) turns the open orders into queue jobs:

- **Stock** is what finished jobs printed, per part and per printer, plus
  corrections, minus what done orders took. Open orders share it in order
  (due date, then when they came in); an order is done the moment its parts
  are all there, and takes them out of stock.
- **Jobs** the planner made are ordinary queue jobs with a row here. A job
  still waiting belongs to the planner, which replaces it on the next plan; a
  job that started is left alone and its pieces count as coming. Parts marked
  matched (a lid and its base) are pinned to one printer; the others are
  "Any <model>" jobs reserved on the printer the plan put them on
  (services/queue_reservations.py).
- **Replanning** happens when an order is added, changed or cancelled, when
  stock is corrected, on request, when one of its prints fails or is stopped,
  and when one of its waiting jobs is cancelled in the queue through
  ``POST /products/queue-items/{id}/cancel`` (print again, the pieces are on
  hand, or withdraw its orders). Nothing else rewrites the planner's jobs.

``after_queue_items_changed`` is called where print batches are refreshed
(services/print_batch.py), so a job's row follows its queue job there.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.db_dialect import upsert_setting
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile, LibraryFileTag
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import (
    Product,
    ProductJob,
    ProductOrder,
    ProductPart,
    ProductPlate,
    ProductStockAdjustment,
)
from backend.app.models.settings import Settings
from backend.app.services import product_planner as planner
from backend.app.services.queue_reservations import model_key

logger = logging.getLogger(__name__)

PLATE_COST_KEY = "product_plate_cost_minutes"
DEFAULT_PLATE_COST_MINUTES = 15
MAX_PLATE_COST_MINUTES = 24 * 60
DEFAULT_DURATION_S = 3600

JOB_TERMINAL = ("done", "failed", "cancelled")
REPLAN_DELAY_S = 2.0
JOB_ACTIVE = ("planned", "printing")


# --- settings ----------------------------------------------------------------


async def read_plate_cost_minutes(db: AsyncSession) -> int:
    raw = (await db.execute(select(Settings.value).where(Settings.key == PLATE_COST_KEY))).scalar()
    try:
        return max(0, min(MAX_PLATE_COST_MINUTES, int(raw))) if raw is not None else DEFAULT_PLATE_COST_MINUTES
    except (TypeError, ValueError):
        return DEFAULT_PLATE_COST_MINUTES


async def write_plate_cost_minutes(db: AsyncSession, minutes: int) -> None:
    """Store it. The caller commits."""
    await upsert_setting(db, Settings, PLATE_COST_KEY, str(max(0, min(MAX_PLATE_COST_MINUTES, minutes))))


# --- reading -----------------------------------------------------------------


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _naive(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo is not None else value


async def load_product(db: AsyncSession, product_id: int) -> Product | None:
    return (
        await db.execute(
            select(Product)
            .where(Product.id == product_id)
            .options(
                selectinload(Product.parts),
                selectinload(Product.skus),
                selectinload(Product.plates).selectinload(ProductPlate.pieces),
                selectinload(Product.plates).selectinload(ProductPlate.library_file),
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


def part_specs(product: Product) -> list[planner.PartSpec]:
    return [
        planner.PartSpec(p.id, max(1, p.quantity or 1), bool(p.matched), max(0, p.finish_minutes or 0) * 60)
        for p in product.parts
    ]


def job_pieces(job: ProductJob, part_ids: set[int]) -> planner.Pieces:
    """A job's pieces as (part id, pieces), for the parts the product still has."""
    result = []
    for key, n in (job.pieces or {}).items():
        try:
            part_id, count = int(key), int(n)
        except (TypeError, ValueError):
            continue
        if part_id in part_ids and count > 0:
            result.append((part_id, count))
    return tuple(sorted(result))


def rejected_pieces(job: ProductJob) -> dict[int, int]:
    """part id -> pieces of a finished job found bad when someone checked them."""
    result = {}
    for key, n in (job.rejected or {}).items():
        try:
            part_id, count = int(key), int(n)
        except (TypeError, ValueError):
            continue
        if count > 0:
            result[part_id] = count
    return result


def good_pieces(job: ProductJob, part_ids: set[int]) -> planner.Pieces:
    """A finished job's pieces less the bad ones (unchecked pieces count as good)."""
    bad = rejected_pieces(job)
    return tuple((part_id, n - min(n, bad.get(part_id, 0))) for part_id, n in job_pieces(job, part_ids))


def plate_pieces(plate: ProductPlate, part_ids: set[int]) -> planner.Pieces:
    return tuple(sorted((p.part_id, p.pieces) for p in plate.pieces if p.part_id in part_ids and p.pieces > 0))


def plate_model(library_file: LibraryFile | None) -> str | None:
    """The model the plate's file was sliced for, in display form ("P1S")."""
    if library_file is None:
        return None
    from backend.app.utils.printer_models import normalize_printer_model

    raw = (library_file.file_metadata or {}).get("sliced_for_model") or library_file.variant_target_model
    return normalize_printer_model(raw) or raw


def plate_duration(plate: ProductPlate) -> int | None:
    """The slicer's print time for the plate: its own in a multi-plate file, else the file's."""
    library_file = plate.library_file
    if library_file is None:
        return None
    duration = (library_file.file_metadata or {}).get("print_time_seconds")
    if plate.plate_id:
        from backend.app.api.routes.print_queue import library_file_disk_path
        from backend.app.utils.threemf_tools import extract_print_time_from_3mf

        path = library_file_disk_path(library_file)
        if path.exists():
            plate_time = extract_print_time_from_3mf(path, plate.plate_id)
            if plate_time is not None:
                duration = plate_time
    return int(duration) if isinstance(duration, (int, float)) and duration > 0 else None


def plate_usable(plate: ProductPlate) -> bool:
    return plate.library_file is not None and plate.library_file.deleted_at is None


def order_sort_key(order: ProductOrder):
    """The order open orders share the stock in: due date first, then arrival."""
    due = _aware(order.due_date)
    return (due is None, due or datetime.min.replace(tzinfo=timezone.utc), order.created_at or datetime.min, order.id)


async def open_orders(db: AsyncSession, product_id: int) -> list[ProductOrder]:
    rows = (
        await db.execute(
            select(ProductOrder).where(ProductOrder.product_id == product_id, ProductOrder.status == "open")
        )
    ).scalars()
    return sorted(rows, key=order_sort_key)


async def active_jobs(db: AsyncSession, product_id: int) -> list[ProductJob]:
    return list(
        (
            await db.execute(
                select(ProductJob)
                .where(ProductJob.product_id == product_id, ProductJob.status.in_(JOB_ACTIVE))
                .order_by(ProductJob.id)
            )
        ).scalars()
    )


# --- following the queue -------------------------------------------------------


def _same_item(job: ProductJob, item: PrintQueueItem) -> bool:
    if job.item_created_at is None or item.created_at is None:
        return True
    return abs((_naive(item.created_at) - _naive(job.item_created_at)).total_seconds()) < 2


async def sync_jobs(db: AsyncSession, jobs: list[ProductJob]) -> list[ProductJob]:
    """Bring each job's status up to its queue job's; returns the jobs that just failed.

    A job whose queue job is gone was cancelled if it never started; one that
    had started takes its print's outcome from the archive.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    active = [j for j in jobs if j.status in JOB_ACTIVE]
    item_ids = [j.queue_item_id for j in active if j.queue_item_id is not None]
    items: dict[int, PrintQueueItem] = {}
    if item_ids:
        rows = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_(item_ids)))).scalars()
        items = {i.id: i for i in rows}
    archive_ids = [j.archive_id for j in active if j.archive_id is not None]
    archive_status: dict[int, str] = {}
    if archive_ids:
        rows = await db.execute(select(PrintArchive.id, PrintArchive.status).where(PrintArchive.id.in_(archive_ids)))
        archive_status = dict(rows.all())

    failed: list[ProductJob] = []
    for job in active:
        item = items.get(job.queue_item_id) if job.queue_item_id is not None else None
        if item is not None and not _same_item(job, item):
            item = None
        if item is None:
            job.queue_item_id = None
            if job.status == "planned":
                job.status = "cancelled"
            elif archive_status.get(job.archive_id or -1) == "completed":
                job.status = "done"
            else:
                job.status = "failed"
                failed.append(job)
            job.finished_at = job.finished_at or now
            continue
        if item.archive_id:
            job.archive_id = item.archive_id
        if item.status == "pending":
            # Being sent; or back to waiting after a start the printer refused.
            job.status = "printing" if item.dispatching_at is not None else "planned"
            if item.printer_id is not None:
                job.printer_id = item.printer_id
        elif item.status == "printing":
            job.status = "printing"
            job.printer_id = item.printer_id or job.printer_id
        elif item.status == "completed":
            job.status = "done"
            job.printer_id = item.printer_id or job.printer_id
            job.finished_at = item.completed_at or now
        elif item.status in ("cancelled", "skipped"):
            job.status = "cancelled"
            job.finished_at = item.completed_at or now
        else:
            job.status = "failed"
            job.printer_id = item.printer_id or job.printer_id
            job.finished_at = item.completed_at or now
            failed.append(job)
    return failed


async def job_of_item(db: AsyncSession, item: PrintQueueItem) -> ProductJob | None:
    """The planner's job behind a waiting or printing queue job; None for one queued by hand."""
    job = (
        await db.execute(
            select(ProductJob)
            .where(ProductJob.queue_item_id == item.id, ProductJob.status.in_(JOB_ACTIVE))
            .order_by(ProductJob.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return job if job is not None and _same_item(job, item) else None


async def queued_jobs(db: AsyncSession, product_id: int) -> list[ProductJob]:
    """The product's jobs whose pieces are still coming: waiting or printing behind their queue job.

    Read only, unlike ``sync_jobs``: a job whose queue job was deleted or
    cancelled (and not followed yet) is left out, so the pieces it was to
    print show as missing at once. A printing job whose row went counts until
    it is followed: its outcome is in the archive.
    """
    jobs = await active_jobs(db, product_id)
    ids = [j.queue_item_id for j in jobs if j.queue_item_id is not None]
    items: dict[int, PrintQueueItem] = {}
    if ids:
        rows = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_(ids)))).scalars()
        items = {i.id: i for i in rows}
    live = []
    for job in jobs:
        item = items.get(job.queue_item_id) if job.queue_item_id is not None else None
        if item is not None and not _same_item(job, item):
            item = None
        if item is None:
            if job.status == "printing":
                live.append(job)
        elif item.status in ("pending", "printing", "completed"):
            live.append(job)
    return live


def put_pieces_in_stock(
    db: AsyncSession, job: ProductJob, part_ids: set[int], *, actor_id: int | None, note: str
) -> planner.Pieces:
    """Put the pieces a job was to print in stock, of no known printer: someone has them already.

    Returns them. The caller replans and commits.
    """
    pieces = job_pieces(job, part_ids)
    for part_id, n in pieces:
        db.add(
            ProductStockAdjustment(part_id=part_id, printer_id=None, delta=n, note=note[:255], created_by_id=actor_id)
        )
    return pieces


@dataclass
class Withdrawal:
    """What withdrawing orders changed."""

    products: set[int] = field(default_factory=set)
    # Product orders taken out of production.
    orders: list[int] = field(default_factory=list)
    # Base orders withdrawn whole (as their Withdraw does).
    base_orders: list[int] = field(default_factory=list)


async def withdraw_orders(db: AsyncSession, product_order_ids: list[int]) -> Withdrawal:
    """Take orders out of production: a Base order goes whole, as its Withdraw does; one entered here is cancelled.

    Orders no longer open are passed over. The caller replans and commits.
    """
    from backend.app.models.base_sync import BaseOrder
    from backend.app.services import base_sync

    result = Withdrawal()
    if not product_order_ids:
        return result
    rows = list((await db.execute(select(ProductOrder).where(ProductOrder.id.in_(product_order_ids)))).scalars())
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for order in sorted(rows, key=lambda o: o.id):
        if order.status != "open":
            continue
        base = None
        if order.external_source == base_sync.EXTERNAL_SOURCE and order.external_ref:
            try:
                base = await db.get(BaseOrder, int(order.external_ref.split("/", 1)[0]))
            except ValueError:
                base = None
        if base is not None and base.state in ("new", "accepted"):
            # Its other products' orders go too; they are not open any more when
            # their turn comes. What is done for it is on the shelf: back to stock.
            result.products |= await base_sync.skip(db, base, return_done=True)
            result.base_orders.append(base.order_id)
        else:
            order.status = "cancelled"
            order.completed_at = now
            result.products.add(order.product_id)
        result.orders.append(order.id)
    await db.flush()
    return result


# --- stock and orders ------------------------------------------------------------


def piece_printer(job: ProductJob) -> int:
    """The printer a job's pieces count on: the one that prints them, or none known.

    Matched parts pair by printer. A pinned job someone moved to another
    printer than the plan's was moved knowingly, as a stock move is: its pieces
    pair with any printer's.
    """
    moved = (
        job.pinned
        and job.planned_printer_id is not None
        and job.printer_id is not None
        and job.printer_id != job.planned_printer_id
    )
    return planner.UNKNOWN_PRINTER if moved else (job.printer_id or planner.UNKNOWN_PRINTER)


async def stock_pool(db: AsyncSession, product: Product) -> planner.Pool:
    """Pieces in stock now: printed (less the ones found bad), corrected, minus what done orders took."""
    part_ids = {p.id for p in product.parts}
    pool: planner.Pool = {}
    done = (
        await db.execute(select(ProductJob).where(ProductJob.product_id == product.id, ProductJob.status == "done"))
    ).scalars()
    for job in done:
        planner.pool_add(pool, piece_printer(job), good_pieces(job, part_ids))
    if part_ids:
        rows = await db.execute(
            select(
                ProductStockAdjustment.part_id, ProductStockAdjustment.printer_id, ProductStockAdjustment.delta
            ).where(ProductStockAdjustment.part_id.in_(part_ids))
        )
        for part_id, printer_id, delta in rows.all():
            planner.pool_add(pool, printer_id or planner.UNKNOWN_PRINTER, ((part_id, delta),))
    consumed = (
        await db.execute(
            select(ProductOrder.consumed).where(ProductOrder.product_id == product.id, ProductOrder.status == "done")
        )
    ).scalars()
    for taken in consumed:
        for part_key, by_printer in (taken or {}).items():
            for printer_key, n in (by_printer or {}).items():
                try:
                    part_id, printer_id, count = int(part_key), int(printer_key), int(n)
                except (TypeError, ValueError):
                    continue
                if part_id in part_ids:
                    planner.pool_add(pool, printer_id, ((part_id, -count),))
    return pool


def needs_of(orders: list[ProductOrder]) -> list[planner.OrderNeed]:
    return [planner.OrderNeed(o.id, max(1, o.quantity), _aware(o.due_date)) for o in orders]


async def complete_ready_orders(db: AsyncSession, product: Product, pool: planner.Pool) -> list[ProductOrder]:
    """Mark open orders whose parts are all there done; their pieces leave stock."""
    orders = await open_orders(db, product.id)
    if not orders:
        return []
    allocation = planner.allocate(part_specs(product), pool, needs_of(orders))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    completed = []
    for order in orders:
        if allocation.units.get(order.id, 0) >= order.quantity:
            order.status = "done"
            order.completed_at = now
            order.consumed = {
                str(part_id): {str(printer_id): n for printer_id, n in by_printer.items() if n}
                for part_id, by_printer in allocation.taken[order.id].items()
            }
            completed.append(order)
    if completed:
        # Stock as it is after them.
        for order in completed:
            for part_id, by_printer in allocation.taken[order.id].items():
                for printer_id, n in by_printer.items():
                    planner.pool_add(pool, printer_id, ((part_id, -n),))
        await db.flush()
    return completed


# --- which orders a job prints for ---------------------------------------------------


@dataclass(frozen=True)
class OrderTag:
    """An order a job prints for, as a label: an Allegro nick or a shop number, the Base id on hover."""

    product_order_id: int
    label: str
    title: str
    base_order_id: int | None = None
    # "allegro" or "shop" for a Base order, None for one entered by hand.
    source_kind: str | None = None
    ship_by: datetime | None = None
    due: datetime | None = None


async def _order_tag_lookup(db: AsyncSession, orders: list[ProductOrder]) -> dict[int, OrderTag]:
    from backend.app.models.base_sync import BaseOrder
    from backend.app.services.base_sync import EXTERNAL_SOURCE, order_label

    base_ids = {}
    for order in orders:
        if order.external_source == EXTERNAL_SOURCE and order.external_ref:
            try:
                base_ids[order.id] = int(order.external_ref.split("/", 1)[0])
            except ValueError:
                pass
    rows = {}
    if base_ids:
        found = await db.execute(select(BaseOrder).where(BaseOrder.order_id.in_(set(base_ids.values()))))
        rows = {row.order_id: row for row in found.scalars()}
    tags = {}
    for order in orders:
        base = rows.get(base_ids.get(order.id, -1))
        if base is not None:
            where = base.source_name or base.source or "Base"
            title = f"Base {base.order_id} · {where}"
            if base.number and order_label(base) != f"#{base.number}":
                title += f" · #{base.number}"
            tags[order.id] = OrderTag(
                order.id,
                order_label(base),
                title,
                base.order_id,
                "allegro" if base.source == "allegro" else "shop",
                base.ship_by,
                order.due_date,
            )
        else:
            text = (order.notes or "").strip()
            tags[order.id] = OrderTag(order.id, text[:24] or f"#{order.id}", text or f"#{order.id}", due=order.due_date)
    return tags


@dataclass
class JobOrders:
    """The orders a job prints for; ``for_stock`` when its pieces go to none."""

    orders: list[OrderTag] = field(default_factory=list)
    for_stock: bool = False


def serve_in_order(
    specs: list[planner.PartSpec], pool: planner.Pool, orders: list[ProductOrder], jobs: list[planner.Pieces]
) -> list[list[ProductOrder]]:
    """Which orders each job's pieces go to, the jobs in the order they print.

    The pieces in ``pool`` go to the orders first (as when orders close), then
    each job's pieces to the orders still short of that part, in ``orders``'
    order (soonest due first). A job serving none prints for stock.
    """
    allocation = planner.allocate(specs, pool, needs_of(orders))
    short = {
        o.id: {p.id: o.quantity * p.per_unit - allocation.pieces.get(o.id, {}).get(p.id, 0) for p in specs}
        for o in orders
    }
    result = []
    for pieces in jobs:
        served: list[ProductOrder] = []
        for part_id, n in pieces:
            left = n
            for order in orders:
                if left <= 0:
                    break
                take = min(left, short[order.id].get(part_id, 0))
                if take > 0:
                    short[order.id][part_id] -= take
                    left -= take
                    if order not in served:
                        served.append(order)
        result.append(served)
    return result


def earliest_due(orders: list[ProductOrder]) -> datetime | None:
    """The soonest due date among orders (aware); None when none has one."""
    dues = [due for due in (_aware(o.due_date) for o in orders) if due is not None]
    return min(dues) if dues else None


def earliest_due_tags(tags: list[OrderTag]) -> datetime | None:
    dues = [due for due in (_aware(t.due) for t in tags) if due is not None]
    return min(dues) if dues else None


async def order_tags(db: AsyncSession) -> tuple[dict[int, JobOrders], dict[int, JobOrders]]:
    """Which open orders each waiting or printing job prints for: by queue job, and by printer printing.

    The pieces in stock go to the orders first (as when orders close), then
    the jobs' pieces in the order they print (the one printing, then the
    queue), each to the orders still short of that part, soonest due first.
    One plate may print for several orders; a job printing only for stock is
    ``for_stock``.
    """
    jobs = list((await db.execute(select(ProductJob).where(ProductJob.status.in_(JOB_ACTIVE)))).scalars())
    by_item: dict[int, JobOrders] = {}
    by_printer: dict[int, JobOrders] = {}
    if not jobs:
        return by_item, by_printer
    item_ids = [j.queue_item_id for j in jobs if j.queue_item_id is not None]
    positions = {}
    if item_ids:
        rows = await db.execute(
            select(PrintQueueItem.id, PrintQueueItem.position).where(PrintQueueItem.id.in_(item_ids))
        )
        positions = dict(rows.all())
    for product_id in sorted({j.product_id for j in jobs}):
        product = await load_product(db, product_id)
        orders = await open_orders(db, product_id)
        if product is None:
            continue
        specs = part_specs(product)
        part_ids = {p.id for p in specs}
        tags = await _order_tag_lookup(db, orders)
        own = sorted(
            (j for j in jobs if j.product_id == product_id),
            key=lambda j: (j.status != "printing", positions.get(j.queue_item_id, 10**9), j.id),
        )
        serving = serve_in_order(
            specs, await stock_pool(db, product), orders, [job_pieces(job, part_ids) for job in own]
        )
        for job, served_orders in zip(own, serving, strict=True):
            served = [tags[order.id] for order in served_orders]
            entry = JobOrders(served, for_stock=not served)
            if job.queue_item_id is not None:
                by_item[job.queue_item_id] = entry
            if job.status == "printing" and job.printer_id is not None:
                printing = by_printer.setdefault(job.printer_id, JobOrders())
                printing.orders.extend(t for t in served if t not in printing.orders)
                printing.for_stock = not printing.orders
    return by_item, by_printer


# --- checking finished pieces -------------------------------------------------------

# A finished job waits this long on the list to be checked; after it, its
# pieces simply count as good (they do from the start, until someone says no).
QC_WINDOW = timedelta(days=7)


async def jobs_to_check(
    db: AsyncSession, printer_id: int | None = None, *, checked: bool = False, on_plate: bool = False
) -> list[ProductJob]:
    """Finished jobs nobody has checked yet (of the last ``QC_WINDOW``), newest first.

    ``checked``: the ones checked in that time instead, last checked first.
    ``on_plate`` (with a printer): only the job on its plate now -- the newest,
    finished after the plate was last cleared -- so the question at plate
    clear never answers for prints set aside earlier.
    """
    from backend.app.models.plate_clears import PlateClear

    since = datetime.now(timezone.utc).replace(tzinfo=None) - QC_WINDOW
    if checked:
        query = select(ProductJob).where(
            ProductJob.status == "done", ProductJob.checked_at.is_not(None), ProductJob.checked_at >= since
        )
        order = (ProductJob.checked_at.desc(), ProductJob.id.desc())
    else:
        query = select(ProductJob).where(
            ProductJob.status == "done",
            ProductJob.checked_at.is_(None),
            ProductJob.finished_at.is_not(None),
            ProductJob.finished_at >= since,
        )
        order = (ProductJob.finished_at.desc(), ProductJob.id.desc())
    if printer_id is not None:
        query = query.where(ProductJob.printer_id == printer_id)
        if on_plate and not checked:
            cleared = await db.scalar(
                select(func.max(PlateClear.cleared_at)).where(
                    PlateClear.printer_id == printer_id, PlateClear.cleared_at.is_not(None)
                )
            )
            if cleared is not None:
                query = query.where(ProductJob.finished_at > cleared)
            query = query.limit(1)
    return list((await db.execute(query.order_by(*order))).scalars())


async def reopen_short_orders(db: AsyncSession, product: Product, pool: planner.Pool) -> list[ProductOrder]:
    """Reopen done orders whose pieces turned out bad afterwards (stock below zero), newest first.

    A box closed the moment its last plate finished, then a piece of it was
    found bad at the check: the order is open again and its pieces go back to
    stock, so the planner prints what is missing.
    """

    def short() -> set[tuple[int, int]]:
        return {(part_id, r) for part_id, by in pool.items() for r, n in by.items() if n < 0}

    missing = short()
    if not missing:
        return []
    rows = (
        await db.execute(
            select(ProductOrder)
            .where(ProductOrder.product_id == product.id, ProductOrder.status == "done")
            .order_by(ProductOrder.completed_at.desc().nulls_last(), ProductOrder.id.desc())
        )
    ).scalars()
    reopened = []
    for order in rows:
        if not missing:
            break
        taken = []
        for part_key, by_printer in (order.consumed or {}).items():
            for printer_key, n in (by_printer or {}).items():
                try:
                    taken.append((int(part_key), int(printer_key), int(n)))
                except (TypeError, ValueError):
                    continue
        if not any((part_id, r) in missing for part_id, r, _ in taken):
            continue
        order.status = "open"
        order.completed_at = None
        order.consumed = None
        for part_id, r, n in taken:
            planner.pool_add(pool, r, ((part_id, n),))
        reopened.append(order)
        missing = short()
    if reopened:
        await db.flush()
    return reopened


async def _job_run(db: AsyncSession, job: ProductJob):
    """The print run (print log entry) of a finished job, when it can be told apart from others."""
    from backend.app.models.print_log import PrintLogEntry

    if job.archive_id is None:
        return None
    if job.queue_item_id is not None:
        run = await db.scalar(
            select(PrintLogEntry)
            .where(PrintLogEntry.archive_id == job.archive_id, PrintLogEntry.queue_item_id == job.queue_item_id)
            .order_by(PrintLogEntry.id.desc())
            .limit(1)
        )
        if run is not None:
            return run
    if job.printer_id is None or job.finished_at is None:
        return None
    candidates = (
        await db.execute(
            select(PrintLogEntry).where(
                PrintLogEntry.archive_id == job.archive_id,
                PrintLogEntry.printer_id == job.printer_id,
                PrintLogEntry.completed_at.is_not(None),
            )
        )
    ).scalars()
    near = [r for r in candidates if abs((r.completed_at - job.finished_at).total_seconds()) <= 600]
    return near[0] if len(near) == 1 else None


async def record_check_verdict(db: AsyncSession, job: ProductJob, source: str | None) -> None:
    """The check as the print's verdict in the archive (good, or reject when every piece was bad).

    Upstream's "ask for the outcome" is off for the planner's jobs, so this is
    the one question; its answer still reaches the archive's statistics. A
    None ``source`` clears it (the check was taken back). Only a run that can
    be told apart is written; a verdict problem never stops the check.
    """
    from backend.app.models.archive import PrintArchive
    from backend.app.services import print_confirmation

    try:
        run = await _job_run(db, job)
        archive = await db.get(PrintArchive, job.archive_id) if job.archive_id is not None else None
        if archive is None or run is None:
            return
        verdict = None
        if source is not None:
            printed = dict(job_pieces(job, {int(k) for k in (job.pieces or {}) if str(k).isdigit()}))
            bad = rejected_pieces(job)
            all_bad = bool(printed) and all(bad.get(part_id, 0) >= n for part_id, n in printed.items())
            verdict = "reject" if all_bad else "good"
        await print_confirmation.record_verdict(db, archive, verdict, source=source, run=run)
    except Exception:
        logger.exception("[PRODUCTS] Could not record the check of job %s in the archive", job.id)


async def uncheck_job(db: AsyncSession, job: ProductJob) -> bool:
    """Take a check back: the job waits to be checked again. Returns whether it had bad pieces.

    The caller replans (when it had) and commits.
    """
    had_bad = bool(rejected_pieces(job))
    job.checked_at = None
    job.rejected = None
    await record_check_verdict(db, job, None)
    await db.flush()
    return had_bad


async def check_job(
    db: AsyncSession, job: ProductJob, rejected: dict[int, int], *, source: str = "dialog"
) -> list[ProductOrder]:
    """Record that a finished job was checked and which pieces were bad; returns the orders reopened.

    Checking again replaces the earlier answer. The caller replans and commits.
    """
    if job.status != "done":
        raise ValueError("Only a finished job can be checked")
    product = await load_product(db, job.product_id)
    if product is None:
        raise ValueError("The job's product is gone")
    printed = dict(job_pieces(job, {p.id for p in product.parts}))
    bad = {}
    for part_id, n in rejected.items():
        if part_id not in printed:
            raise ValueError(f"The job printed no pieces of part {part_id}")
        if n > 0:
            bad[part_id] = min(n, printed[part_id])
    job.checked_at = datetime.now(timezone.utc).replace(tzinfo=None)
    job.rejected = {str(part_id): n for part_id, n in bad.items()} or None
    await record_check_verdict(db, job, source)
    await db.flush()
    return await reopen_short_orders(db, product, await stock_pool(db, product))


async def refresh_product(db: AsyncSession, product: Product) -> tuple[planner.Pool, list[ProductJob]]:
    """Follow the queue and close finished orders; returns the stock and the jobs that just failed."""
    await link_hand_jobs(db, product=product)
    failed = await sync_jobs(db, await active_jobs(db, product.id))
    await db.flush()
    pool = await stock_pool(db, product)
    await complete_ready_orders(db, product, pool)
    return pool, failed


# --- planning -------------------------------------------------------------------


@dataclass
class PlanOutcome:
    plan: planner.Plan | None
    # Queue jobs made by this plan, in start order.
    item_ids: list[int] = field(default_factory=list)
    # Waiting jobs the plan kept as they were (same plate, same printer).
    kept: int = 0
    # Waiting jobs it took out of the queue.
    replaced: int = 0
    # Waiting jobs queued or moved by hand that it kept as they are.
    held: int = 0
    # Plates it could not use: (plate id, why).
    skipped_plates: list[tuple[int, str]] = field(default_factory=list)


async def _file_tag_ids(db: AsyncSession, file_ids: set[int]) -> dict[int, frozenset[int]]:
    if not file_ids:
        return {}
    rows = await db.execute(
        select(LibraryFileTag.file_id, LibraryFileTag.tag_id).where(LibraryFileTag.file_id.in_(file_ids))
    )
    tags: dict[int, set[int]] = {}
    for file_id, tag_id in rows.all():
        tags.setdefault(file_id, set()).add(tag_id)
    return {file_id: frozenset(ids) for file_id, ids in tags.items()}


async def _waiting_jobs(db: AsyncSession, jobs: list[ProductJob]) -> list[ProductJob]:
    """The planner's jobs still waiting in the queue and not being sent."""
    planned = [j for j in jobs if j.status == "planned" and j.queue_item_id is not None]
    if not planned:
        return []
    waiting = set(
        (
            await db.execute(
                select(PrintQueueItem.id).where(
                    PrintQueueItem.id.in_([j.queue_item_id for j in planned]),
                    PrintQueueItem.status == "pending",
                    PrintQueueItem.dispatching_at.is_(None),
                )
            )
        ).scalars()
    )
    return [j for j in planned if j.queue_item_id in waiting]


async def _remove_waiting_jobs(db: AsyncSession, jobs: list[ProductJob]) -> int:
    """Delete the planner's queue jobs that have not started; their rows go too."""
    planned = [j for j in jobs if j.status == "planned" and j.queue_item_id is not None]
    if not planned:
        return 0
    ids = [j.queue_item_id for j in planned]
    # Only what is still waiting and not being sent: the scheduler may have
    # claimed one since the jobs were read.
    deletable = set(
        (
            await db.execute(
                select(PrintQueueItem.id).where(
                    PrintQueueItem.id.in_(ids),
                    PrintQueueItem.status == "pending",
                    PrintQueueItem.dispatching_at.is_(None),
                )
            )
        ).scalars()
    )
    if deletable:
        await db.execute(
            delete(PrintQueueItem).where(
                PrintQueueItem.id.in_(deletable),
                PrintQueueItem.status == "pending",
                PrintQueueItem.dispatching_at.is_(None),
            )
        )
    removed = 0
    for job in planned:
        if job.queue_item_id in deletable:
            await db.delete(job)
            removed += 1
    await db.flush()
    return removed


async def link_hand_jobs(
    db: AsyncSession, *, product: Product | None = None, item_ids: list[int] | None = None
) -> list[ProductJob]:
    """Link queue jobs someone queued by hand that print a product plate's file, so their pieces count.

    A plate's file printed from the library, the history or a printer card is
    an ordinary queue job: without this its pieces would not reach the stock,
    its orders would not close, and the next plan would print them again. A
    job is linked when exactly one product plate is its file and plate (from
    the job, or the archive it reprints). With ``product`` its plates' waiting
    and printing jobs are looked at; with ``item_ids`` those queue jobs, in any
    state (one that just finished). The caller commits.
    """
    from sqlalchemy import or_

    from backend.app.models.products import ProductPlatePart

    if product is not None:
        plates = [plate for plate in product.plates if plate_usable(plate)]
    else:
        plates = list((await db.execute(select(ProductPlate).options(selectinload(ProductPlate.pieces)))).scalars())
    by_file: dict[int, list[ProductPlate]] = {}
    for plate in plates:
        by_file.setdefault(plate.library_file_id, []).append(plate)
    if not by_file or (item_ids is not None and not item_ids):
        return []
    query = select(PrintQueueItem, PrintArchive.library_file_id, PrintArchive.plate_id).outerjoin(
        PrintArchive, PrintArchive.id == PrintQueueItem.archive_id
    )
    if item_ids is not None:
        query = query.where(PrintQueueItem.id.in_(item_ids))
    else:
        files = list(by_file)
        query = query.where(
            PrintQueueItem.status.in_(("pending", "printing")),
            or_(PrintQueueItem.library_file_id.in_(files), PrintArchive.library_file_id.in_(files)),
        )
    rows = (await db.execute(query)).all()
    if not rows:
        return []
    known = (
        await db.execute(
            select(ProductJob.queue_item_id, ProductJob.item_created_at).where(
                ProductJob.queue_item_id.in_([item.id for item, _, _ in rows])
            )
        )
    ).all()
    linked: list[ProductJob] = []
    for item, archive_file, archive_plate in rows:
        if any(
            item_id == item.id and _same_item(ProductJob(item_created_at=created), item) for item_id, created in known
        ):
            continue
        file_id = item.library_file_id or archive_file
        plate_no = item.plate_id or archive_plate
        matches = [p for p in by_file.get(file_id, []) if p.plate_id is None or p.plate_id == plate_no]
        if len(matches) != 1:
            continue
        plate = matches[0]
        pieces: list[ProductPlatePart] = [piece for piece in plate.pieces if piece.pieces > 0]
        if not pieces:
            continue
        job = ProductJob(
            product_id=plate.product_id,
            product_plate_id=plate.id,
            queue_item_id=item.id,
            item_created_at=item.created_at,
            printer_id=item.printer_id,
            planned_printer_id=item.printer_id,
            pinned=item.printer_id is not None,
            by_hand=True,
            status="printing" if item.status == "printing" else "planned",
            pieces={str(piece.part_id): piece.pieces for piece in pieces},
        )
        db.add(job)
        linked.append(job)
    if linked:
        await db.flush()
        logger.info(
            "[PRODUCTS] Linked queue jobs %s queued by hand to product plates", [j.queue_item_id for j in linked]
        )
    return linked


async def _placed_on(db: AsyncSession, jobs: list[ProductJob], items: dict[int, PrintQueueItem]) -> dict[int, int]:
    """Job id -> the printer a waiting job is on now: pinned to, else held for on the timeline, else the plan's."""
    from backend.app.models.queue_reservations import QueueReservation

    reserved: dict[int, int] = {}
    ids = [j.queue_item_id for j in jobs if j.queue_item_id is not None]
    if ids:
        rows = (await db.execute(select(QueueReservation).where(QueueReservation.queue_item_id.in_(ids)))).scalars()
        for row in rows:
            item = items.get(row.queue_item_id)
            if item is not None and _same_item(ProductJob(item_created_at=row.item_created_at), item):
                reserved[row.queue_item_id] = row.printer_id
    result = {}
    for job in jobs:
        item = items.get(job.queue_item_id or -1)
        planned = job.planned_printer_id if job.planned_printer_id is not None else job.printer_id
        if item is not None and item.printer_id is not None:
            result[job.id] = item.printer_id
        elif job.queue_item_id in reserved:
            result[job.id] = reserved[job.queue_item_id]
        elif planned is not None:
            result[job.id] = planned
    return result


async def placed_by_hand(db: AsyncSession, jobs: list[ProductJob]) -> tuple[dict[int, int], set[int]]:
    """For the waiting ones of ``jobs``: job id -> the printer it is on now, and the ids moved by hand."""
    waiting = await _waiting_jobs(db, jobs)
    if not waiting:
        return {}, set()
    items = {
        item.id: item
        for item in (
            await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_([j.queue_item_id for j in waiting])))
        ).scalars()
    }
    placed_on = await _placed_on(db, waiting, items)
    return placed_on, {j.id for j in waiting if _moved_by_hand(j, placed_on.get(j.id))}


def _moved_by_hand(job: ProductJob, placed_on: int | None) -> bool:
    planned = job.planned_printer_id if job.planned_printer_id is not None else job.printer_id
    return placed_on is not None and planned is not None and placed_on != planned


async def replan(
    db: AsyncSession,
    product_id: int,
    *,
    actor_id: int | None,
    manual_start: bool = False,
    printer_ids: frozenset[int] | None = None,
) -> PlanOutcome:
    """Plan the product's open orders again and put the plates in the queue.

    Started jobs stay and count as coming. So do the waiting jobs that are the
    user's: one queued by hand (linked here first, see ``link_hand_jobs``) and
    one moved by hand to another printer (pinned, or held for it on the
    timeline); a moved one the orders no longer need leaves the queue. A
    waiting job the new plan has too (the same plate on the same printer) is
    kept where it is in the queue, with whatever was changed on it (filament
    mapping, options); the other waiting jobs leave the queue. New jobs go in
    before the first waiting job of another product due later than the orders
    they print for (after the plan's earlier plates), else at the end.
    ``printer_ids`` limits the printers (the user's printer scope);
    ``manual_start`` makes new jobs wait for someone to press Start. The
    caller commits.
    """
    from backend.app.services.print_defaults import default_print_options
    from backend.app.services.printer_tags import NO_TAGS, read_printer_tags
    from backend.app.services.queue_forecast import load_forecast_inputs, place_jobs
    from backend.app.services.queue_position import lock_queue_positions
    from backend.app.services.queue_reservations import reserve

    product = await load_product(db, product_id)
    if product is None:
        return PlanOutcome(plan=None)
    await link_hand_jobs(db, product=product)
    jobs = await active_jobs(db, product.id)
    await sync_jobs(db, jobs)
    await db.flush()
    pool = await stock_pool(db, product)
    await complete_ready_orders(db, product, pool)
    orders = await open_orders(db, product.id)
    jobs = await active_jobs(db, product.id)
    waiting = await _waiting_jobs(db, jobs)
    items = {
        item.id: item
        for item in (
            await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_([j.queue_item_id for j in waiting])))
        ).scalars()
    }
    # The user's waiting jobs: queued or moved by hand. They stay as they are
    # while the orders need them; the plan goes around them.
    placed_on = await _placed_on(db, waiting, items)
    held = sorted(
        (j for j in waiting if j.by_hand or _moved_by_hand(j, placed_on.get(j.id))),
        key=lambda j: (items[j.queue_item_id].position or 0, j.id),
    )
    for job in held:
        if job.planned_printer_id is None:
            # A job from before the plan's printer was kept: remember it, so the
            # move is still a move at the next plan.
            job.planned_printer_id = job.printer_id
        job.printer_id = placed_on.get(job.id, job.printer_id)
    specs = part_specs(product)
    part_ids = {p.id for p in product.parts}
    printing = [job for job in jobs if job.status == "printing"]
    coming = {part_id: dict(by_printer) for part_id, by_printer in pool.items()}
    for job in printing:
        planner.pool_add(coming, piece_printer(job), job_pieces(job, part_ids))
    needed = serve_in_order(specs, coming, orders, [job_pieces(job, part_ids) for job in held])
    unneeded = [job for job, served in zip(held, needed, strict=True) if not served and not job.by_hand]
    held = [job for job in held if job not in unneeded]
    waiting = [job for job in waiting if job not in held and job not in unneeded]
    waiting_items = {job.queue_item_id for job in waiting} | {job.queue_item_id for job in unneeded}

    inputs = await load_forecast_inputs(db)
    now = inputs.now
    ready_after = inputs.ready_after
    # The lanes as they are without this product's waiting jobs: the plan
    # places them again.
    others = [job for job in inputs.schedulable if job.id not in waiting_items]
    placements, _ = place_jobs(others, inputs.printers, now, ready_after)
    lane_end = {p.id: max(_aware(p.free_at) or now, now) for p in inputs.printers}
    for placement in placements:
        end = ready_after(placement.end) if ready_after is not None else placement.end
        lane_end[placement.printer_id] = max(lane_end[placement.printer_id], end)
    printer_free = {p.id: max(_aware(p.free_at) or now, now) for p in inputs.printers}

    arriving = [
        planner.Arrival(printer_free.get(job.printer_id or 0, now), piece_printer(job), job_pieces(job, part_ids))
        for job in printing
    ]
    placed = {placement.item_id: placement for placement in placements}
    for job in held:
        placement = placed.get(job.queue_item_id)
        if placement is not None:
            at = ready_after(placement.end) if ready_after is not None else placement.end
        else:
            at = lane_end.get(job.printer_id or 0, now)
        arriving.append(planner.Arrival(at, piece_printer(job), job_pieces(job, part_ids)))

    # Printers that can take work now; when none can (all switched off for the
    # night, no Auto On plug), every enabled one, so an order still gets planned.
    usable = [p for p in inputs.printers if p.is_active and (printer_ids is None or p.id in printer_ids)]
    online = [p for p in usable if p.available]
    printers = [planner.PlannerPrinter(p.id, model_key(p.model), lane_end[p.id]) for p in (online or usable)]

    tags = await read_printer_tags(db)
    used_tags = frozenset().union(*(t.tag_ids for t in tags.values())) if tags else frozenset()
    file_tags = await _file_tag_ids(db, {plate.library_file_id for plate in product.plates})
    options: list[planner.PlateOption] = []
    plates_by_id: dict[int, ProductPlate] = {}
    skipped: list[tuple[int, str]] = []
    for plate in product.plates:
        if not plate_usable(plate):
            skipped.append((plate.id, "file_missing"))
            continue
        pieces = plate_pieces(plate, part_ids)
        model = plate_model(plate.library_file)
        if not pieces:
            skipped.append((plate.id, "no_pieces"))
            continue
        if not model:
            skipped.append((plate.id, "no_model"))
            continue
        wanted = file_tags.get(plate.library_file_id, frozenset()) & used_tags
        allowed = None
        if wanted or any(t.exclusive and t.tag_ids for t in tags.values()):
            allowed = frozenset(p.id for p in printers if tags.get(p.id, NO_TAGS).accepts(wanted))
        options.append(
            planner.PlateOption(
                id=plate.id,
                model=model_key(model),
                duration_s=plate_duration(plate) or DEFAULT_DURATION_S,
                pieces=pieces,
                printers=allowed,
            )
        )
        plates_by_id[plate.id] = plate

    plate_cost = await read_plate_cost_minutes(db)
    result = planner.plan(
        planner.PlanInputs(
            now=now,
            parts=specs,
            options=options,
            printers=printers,
            orders=needs_of(orders),
            stock=pool,
            arriving=arriving,
            plate_cost_s=plate_cost * 60,
            ready_after=ready_after,
        )
    )

    rank = {p.id: i for i, p in enumerate(inputs.printers)}
    planned = sorted(result.plates, key=lambda p: (p.start, rank.get(p.printer_id, 0)))
    outcome = PlanOutcome(plan=result, skipped_plates=skipped, held=len(held))
    if not planned:
        outcome.replaced = await _remove_waiting_jobs(db, waiting + unneeded)
        return outcome

    from backend.app.api.routes.library_variants import normalize_model_name
    from backend.app.api.routes.print_queue import (
        _extract_filament_types_from_3mf,
        library_file_disk_path,
        printed_plate_of_multi_plate_file,
    )
    from backend.app.models.printer import Printer
    from backend.app.services.print_cost_estimate import estimate_queue_source_cost

    printer_models = dict((await db.execute(select(Printer.id, Printer.model))).all())
    defaults = await default_print_options(db)
    await lock_queue_positions(db)
    filament_types: dict[tuple[int, int | None], list[str]] = {}
    reusable: dict[tuple[int | None, int | None, bool], list[ProductJob]] = {}
    for job in waiting:
        reusable.setdefault((job.product_plate_id, job.printer_id, bool(job.pinned)), []).append(job)
    for queue in reusable.values():
        queue.sort(key=lambda j: (items[j.queue_item_id].position or 0, j.id))

    # Where new jobs go: by the soonest due order each plate prints for,
    # against the other products' waiting jobs (the stock, the prints running
    # and the held jobs serve the orders first).
    for job in held:
        planner.pool_add(coming, piece_printer(job), job_pieces(job, part_ids))
    plate_dues = [
        earliest_due(served) for served in serve_in_order(specs, coming, orders, [p.option.pieces for p in planned])
    ]
    own_items = {job.queue_item_id for job in jobs}
    other_dues: dict[int, datetime] = {}
    for item_id, entry in (await order_tags(db))[0].items():
        due = earliest_due_tags(entry.orders)
        if item_id not in own_items and due is not None:
            other_dues[item_id] = due
    queue = list(
        (
            await db.execute(
                select(PrintQueueItem)
                .where(PrintQueueItem.status == "pending")
                .order_by(PrintQueueItem.position, PrintQueueItem.id)
            )
        ).scalars()
    )

    def place(due: datetime | None, after: int) -> int:
        """A position for a new job, making room for it; never at or before ``after``."""
        if due is not None:
            for other in sorted(queue, key=lambda i: (i.position or 0, i.id)):
                at = other.position or 0
                if at > after and other.id in other_dues and other_dues[other.id] > due:
                    for moved in queue:
                        if (moved.position or 0) >= at:
                            moved.position = (moved.position or 0) + 1
                    return at
        return max([after, *(i.position or 0 for i in queue)]) + 1

    after = 0
    for planned_plate, due in zip(planned, plate_dues, strict=True):
        plate = plates_by_id[planned_plate.option.id]
        pinned = planned_plate.pinned
        kept_jobs = reusable.get((plate.id, planned_plate.printer_id, pinned))
        if kept_jobs:
            # Kept where it is in the queue.
            job = kept_jobs.pop(0)
            item = items[job.queue_item_id]
            after = max(after, item.position or 0)
            job.pieces = {str(part_id): n for part_id, n in planned_plate.option.pieces}
            if not pinned:
                await reserve(db, item, planned_plate.printer_id)
            waiting.remove(job)
            outcome.kept += 1
            continue
        library_file = plate.library_file
        path = library_file_disk_path(library_file)
        plate_id = plate.plate_id or printed_plate_of_multi_plate_file(path)
        target_model = None if pinned else normalize_model_name(printer_models.get(planned_plate.printer_id))
        required_types = None
        if target_model:
            key = (library_file.id, plate_id)
            if key not in filament_types:
                filament_types[key] = _extract_filament_types_from_3mf(path, plate_id) if path.exists() else []
            if filament_types[key]:
                required_types = json.dumps(filament_types[key])
        try:
            cost = await estimate_queue_source_cost(
                db, library_file=library_file, plate_id=plate_id, printer_id=planned_plate.printer_id
            )
        except Exception:  # an estimate is a nicety; never block the plan on it
            cost = None
        item = PrintQueueItem(
            printer_id=planned_plate.printer_id if pinned else None,
            target_model=target_model,
            required_filament_types=required_types,
            library_file_id=library_file.id,
            plate_id=plate_id,
            print_time_seconds=planned_plate.option.duration_s,
            estimated_cost=cost,
            manual_start=manual_start,
            position=place(due, after),
            status="pending",
            created_by_id=actor_id,
            **defaults,
        )
        after = item.position
        db.add(item)
        await db.flush()
        await db.refresh(item, ["created_at"])
        queue.append(item)
        if not pinned:
            await reserve(db, item, planned_plate.printer_id)
        db.add(
            ProductJob(
                product_id=product.id,
                product_plate_id=plate.id,
                queue_item_id=item.id,
                item_created_at=item.created_at,
                printer_id=planned_plate.printer_id,
                planned_printer_id=planned_plate.printer_id,
                pinned=pinned,
                status="planned",
                pieces={str(part_id): n for part_id, n in planned_plate.option.pieces},
            )
        )
        outcome.item_ids.append(item.id)
    await db.flush()
    outcome.replaced = await _remove_waiting_jobs(db, waiting + unneeded)
    return outcome


async def announce_planned(item_ids: list[int]) -> None:
    """Tell the queue's listeners about the new jobs, after the caller's commit."""
    if not item_ids:
        return
    from backend.app.core import database
    from backend.app.services.queue_announcements import announce_queue_jobs_added

    try:
        async with database.async_session() as db:
            await announce_queue_jobs_added(db, item_ids)
    except Exception as e:
        logger.warning("[PRODUCTS] Could not announce planned jobs %s: %s", item_ids, e)


# --- what the page shows ------------------------------------------------------------


async def order_estimates(
    db: AsyncSession, product: Product, pool: planner.Pool, orders: list[ProductOrder], forecast=None
) -> dict[int, datetime | None]:
    """When each open order is expected to be ready, from the queue forecast (built when not given)."""
    if not orders:
        return {}
    from backend.app.services.queue_forecast import build_queue_forecast

    if forecast is None:
        forecast = await build_queue_forecast(db)
    now = forecast.generated_at
    ready_after = forecast.turnaround.as_function() if forecast.turnaround is not None else None
    placed = {p.item_id: p for p in forecast.placements}
    free_at = {p.printer_id: _aware(p.free_at) or now for p in forecast.printers}
    part_ids = {p.id for p in product.parts}
    arrivals = planner.stock_arrivals(pool, now)
    for job in await active_jobs(db, product.id):
        pieces = job_pieces(job, part_ids)
        if job.status == "printing":
            arrivals.append(
                planner.Arrival(max(free_at.get(job.printer_id or 0, now), now), piece_printer(job), pieces)
            )
        elif job.queue_item_id in placed:
            p = placed[job.queue_item_id]
            ready = ready_after(p.end) if ready_after is not None else p.end
            arrivals.append(planner.Arrival(max(ready, p.end), p.printer_id, pieces))
    return planner.ready_times(part_specs(product), needs_of(orders), arrivals, now)


# --- the queue's hook -----------------------------------------------------------------


_background: set[asyncio.Task] = set()
# At most this many replans after failed prints per product within the window:
# a printer failing everything it is given must not loop the planner.
AUTO_REPLAN_LIMIT = 3
AUTO_REPLAN_WINDOW_S = 3600
_auto_replans: dict[int, list[float]] = {}


def _may_auto_replan(product_id: int, now: float) -> bool:
    recent = [t for t in _auto_replans.get(product_id, []) if now - t < AUTO_REPLAN_WINDOW_S]
    if len(recent) >= AUTO_REPLAN_LIMIT:
        _auto_replans[product_id] = recent
        return False
    _auto_replans[product_id] = [*recent, now]
    return True


async def after_queue_items_changed(db: AsyncSession, queue_item_ids: list[int]) -> None:
    """Follow queue jobs the planner made; replan a product whose print failed or was stopped.

    Called where print batches are refreshed, in the caller's session; changes
    are left for the caller to commit. The replan runs afterwards, in its own
    session, acting for whoever queued the failed job. Only a print that
    started counts: a job the printer never started (the scheduler gives up
    after its retries) is left for someone to look at, as is a product whose
    prints keep failing (AUTO_REPLAN_LIMIT). A print stopped part way counts
    as failed: someone who no longer wants it withdraws its order instead.
    """
    if not queue_item_ids:
        return
    # A plate's file queued by hand that just finished (or failed) counts too.
    await link_hand_jobs(db, item_ids=queue_item_ids)
    jobs = list(
        (
            await db.execute(
                select(ProductJob).where(
                    ProductJob.queue_item_id.in_(queue_item_ids), ProductJob.status.in_(JOB_ACTIVE)
                )
            )
        ).scalars()
    )
    if not jobs:
        return
    items = {
        i.id: i
        for i in (
            await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_([j.queue_item_id for j in jobs])))
        ).scalars()
    }
    failed = await sync_jobs(db, jobs)
    await db.flush()
    for product_id in sorted({j.product_id for j in jobs}):
        product = await load_product(db, product_id)
        if product is not None:
            await complete_ready_orders(db, product, await stock_pool(db, product))
    # A print stopped part way (Stop in the queue, cancelled on the printer)
    # made no pieces either: its orders are short just the same.
    stopped = [
        j
        for j in jobs
        if j.status == "cancelled"
        and (item := items.get(j.queue_item_id or -1)) is not None
        and item.status == "cancelled"
        and item.started_at
    ]
    started = [
        j for j in failed if (item := items.get(j.queue_item_id or -1)) is not None and item.started_at
    ] + stopped
    for product_id in sorted({j.product_id for j in started}):
        if not _may_auto_replan(product_id, time.monotonic()):
            logger.warning("[PRODUCTS] Product %s: prints keep failing, not replanning it again for now", product_id)
            continue
        source = next(items[j.queue_item_id] for j in started if j.product_id == product_id)
        task = asyncio.get_running_loop().create_task(
            _replan_later(product_id, source.created_by_id, bool(source.manual_start))
        )
        _background.add(task)
        task.add_done_callback(_background.discard)


async def _replan_later(product_id: int, actor_id: int | None, manual_start: bool) -> None:
    # Let the caller's commit land first; the queue job's own status is
    # committed already, and the replan reads it again.
    await asyncio.sleep(REPLAN_DELAY_S)
    from backend.app.core import database
    from backend.app.core.printer_scope import resolve_user_id_printer_scope

    try:
        async with database.async_session() as db:
            scope = await resolve_user_id_printer_scope(db, actor_id)
            outcome = await replan(
                db, product_id, actor_id=actor_id, manual_start=manual_start, printer_ids=scope.printer_ids
            )
            await db.commit()
        await announce_planned(outcome.item_ids)
        logger.info("[PRODUCTS] Replanned product %s after a print failed or was stopped", product_id)
    except Exception as e:
        logger.warning("[PRODUCTS] Could not replan product %s after a print failed or was stopped: %s", product_id, e)


# --- thumbnails -------------------------------------------------------------------------

THUMBNAIL_DIR = Path("products") / "thumbnails"
THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024
THUMBNAIL_SIZE = 512


class ThumbnailError(ValueError):
    """The image can't be read."""


def _thumbnails_dir() -> Path:
    from backend.app.core.config import settings

    directory = settings.base_dir / THUMBNAIL_DIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _absolute(relative: str | None) -> Path | None:
    if not relative:
        return None
    from backend.app.core.config import settings

    path = Path(relative)
    return path if path.is_absolute() else settings.base_dir / path


def remove_thumbnail(product: Product) -> None:
    """Forget the uploaded picture and delete its file. The caller commits."""
    path = _absolute(product.thumbnail_path)
    product.thumbnail_path = None
    if path is not None and path.is_file() and path.parent == _thumbnails_dir():
        path.unlink(missing_ok=True)


def save_thumbnail(product: Product, data: bytes) -> None:
    """Store ``data`` (any image Pillow reads) as the product's picture, as a PNG of at most 512 px.

    The caller commits. Raises ThumbnailError for something that is not an image.
    """
    import io
    import uuid

    from PIL import Image, UnidentifiedImageError

    if len(data) > THUMBNAIL_MAX_BYTES:
        raise ThumbnailError(f"The image is larger than {THUMBNAIL_MAX_BYTES // (1024 * 1024)} MB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            picture = image.convert("RGBA") if image.mode not in ("RGB", "RGBA") else image.copy()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ThumbnailError("The file is not an image") from exc
    picture.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
    name = f"{product.id}_{uuid.uuid4().hex}.png"
    picture.save(_thumbnails_dir() / name, format="PNG")
    remove_thumbnail(product)
    product.thumbnail_path = str(THUMBNAIL_DIR / name)


def thumbnail_file(product: Product) -> Path | None:
    """The picture to show: the uploaded one, else the first plate's file thumbnail."""
    uploaded = _absolute(product.thumbnail_path)
    if uploaded is not None and uploaded.is_file():
        return uploaded
    for plate in product.plates:
        if plate_usable(plate) and plate.library_file.thumbnail_path:
            path = _absolute(plate.library_file.thumbnail_path)
            if path is not None and path.is_file():
                return path
    return None


def thumbnail_version(product: Product) -> str | None:
    """Changes with the picture a product shows (for caches); None without one."""
    if product.thumbnail_path:
        return product.thumbnail_path.rsplit("/", 1)[-1].removesuffix(".png")
    first = next((p for p in product.plates if plate_usable(p) and p.library_file.thumbnail_path), None)
    return f"plate-{first.library_file_id}" if first is not None else None


def has_thumbnail(product: Product) -> bool:
    return bool(product.thumbnail_path) or any(
        plate_usable(plate) and plate.library_file.thumbnail_path for plate in product.plates
    )


# --- suggesting plates from file names ------------------------------------------------------

_COUNT_PATTERNS = (
    re.compile(r"(?:^| )x ?(\d{1,3})(?: |$)"),
    re.compile(r"(?:^| )(\d{1,3}) ?(?:x|szt|pcs|pc|st|stk)(?: |$)"),
)


def fold(text: str) -> str:
    """Lower case, no diacritics, words split on anything else: "Góra_x2" -> "gora x2"."""
    import unicodedata

    text = text.lower().replace("ł", "l")
    text = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return " ".join(re.split(r"[^a-z0-9]+", text)).strip()


def _count_in_name(text: str) -> int | None:
    for pattern in _COUNT_PATTERNS:
        match = pattern.search(text)
        if match:
            count = int(match.group(1))
            if count > 0:
                return count
    return None


@dataclass
class PlateGuess:
    library_file: LibraryFile
    # part id -> pieces; empty when the name says nothing usable
    pieces: dict[int, int]
    # How the pieces were found: "single_part", "name", or None.
    found_by: str | None


def guess_plate(
    parts: list[ProductPart], library_file: LibraryFile, keywords: dict[str, list[str]] | None = None
) -> PlateGuess:
    """Which parts a sliced file prints, from its name and objects.

    A part is named in the file when its name, or one of ``keywords[part
    name]``, is a word (or words) of the file name or print name. The pieces
    are the plate's objects (one plate in the file), else a count in the name
    ("x3", "3szt", "3pcs"), else 1; a file naming several parts splits its
    objects evenly between them when they divide, else takes the count in the
    name for each.
    """
    meta = library_file.file_metadata or {}
    objects_raw = meta.get("printable_objects")
    objects = len(objects_raw) if isinstance(objects_raw, dict) and objects_raw else None
    text = f" {fold(str(meta.get('print_name') or ''))} {fold(library_file.filename or '')} "
    named_count = _count_in_name(text.strip())
    if len(parts) == 1:
        return PlateGuess(library_file, {parts[0].id: objects or named_count or 1}, "single_part")
    keywords = {fold(k): v for k, v in (keywords or {}).items()}
    named = []
    for part in parts:
        words = [fold(part.name), *(fold(w) for w in keywords.get(fold(part.name), []))]
        if any(len(w) >= 2 and f" {w} " in text for w in words):
            named.append(part)
    if not named:
        return PlateGuess(library_file, {}, None)
    if len(named) == 1:
        return PlateGuess(library_file, {named[0].id: objects or named_count or 1}, "name")
    if objects is not None and objects % len(named) == 0:
        return PlateGuess(library_file, {p.id: objects // len(named) for p in named}, "name")
    return PlateGuess(library_file, {p.id: named_count or 1 for p in named}, "name")


async def folder_and_below(db: AsyncSession, folder_id: int) -> set[int]:
    from backend.app.models.library import LibraryFolder

    found = {folder_id}
    frontier = [folder_id]
    while frontier:
        children = (await db.execute(select(LibraryFolder.id).where(LibraryFolder.parent_id.in_(frontier)))).scalars()
        frontier = [c for c in children if c not in found]
        found.update(frontier)
    return found


def is_sliced_file(library_file: LibraryFile) -> bool:
    name = (library_file.filename or "").lower()
    return name.endswith((".gcode.3mf", ".gcode")) or bool((library_file.file_metadata or {}).get("sliced_for_model"))
