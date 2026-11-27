"""Products, their orders and the queue jobs that print them (fork).

A product is parts; its plates are sliced files that print pieces of them
(models/products.py). An order wants some products. The planner
(services/product_planner.py) turns the open orders into queue jobs:

- **Stock** is what finished jobs printed, per part and per printer, plus
  corrections, minus what done orders took. Open orders share it in order
  (due date, then when they came in); an order is done the moment its parts
  are all there, and takes them out of stock. A plate printed by hand counts
  only when the settings say so (``ProductJob.counted``): otherwise it shows,
  but its pieces are neither stock nor coming, and the orders print in full.
- **Jobs** the planner made are ordinary queue jobs with a row here. A job
  still waiting belongs to the planner, which replaces it on the next plan; a
  job that started is left alone and its pieces count as coming. Parts marked
  matched (a lid and its base) are pinned to one printer; the others are
  "Any <model>" jobs reserved on the printer the plan put them on
  (services/queue_reservations.py), a hold that yields when that printer
  cannot take the job soon. A plate is planned with how long it really
  prints and how often it fails (services/plate_history.py).
- **Replanning** happens when an order is added, changed or cancelled, when
  stock is corrected, on request, when one of its prints fails or is stopped,
  and when one of its waiting jobs is cancelled in the queue through
  ``POST /products/queue-items/{id}/cancel`` (print again, the pieces are on
  hand, or withdraw its orders). Nothing else rewrites the planner's jobs.
  Each of these is one pass (``replan_pass``): the products asked for and
  every less urgent product behind them, the most urgent planned first, so
  each plan is made for the hours its place in the queue gives it.

``after_queue_items_changed`` is called where print batches are refreshed
(services/print_batch.py), so a job's row follows its queue job there.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import Counter
from collections.abc import Iterable
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
from backend.app.services import product_filament, product_planner as planner
from backend.app.services.queue_reservations import YIELD_SETTING_KEY, model_key

logger = logging.getLogger(__name__)

PLATE_COST_KEY = "product_plate_cost_minutes"
DEFAULT_PLATE_COST_MINUTES = 15
MAX_PLATE_COST_MINUTES = 24 * 60
DEFAULT_DURATION_S = 3600

JOB_TERMINAL = ("done", "failed", "cancelled")
REPLAN_DELAY_S = 2.0
# Plans of a product made again when a waiting job it was planned around
# started meanwhile (the planner runs off the event loop, the scheduler on it).
PLAN_TRIES = 3
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


# A preferred printer loses to another only when that one is done this much
# sooner: the larger of the minutes and the share of the plate's print time.
PREFER_MINUTES_KEY = "product_prefer_margin_minutes"
PREFER_PCT_KEY = "product_prefer_margin_pct"
DEFAULT_PREFER_MINUTES = 30
DEFAULT_PREFER_PCT = 25
MAX_PREFER_MINUTES = 24 * 60
# Loading a spool or changing one that runs out, once someone is there.
SWAP_MINUTES_KEY = "product_filament_swap_minutes"
DEFAULT_SWAP_MINUTES = 10
MAX_SWAP_MINUTES = 4 * 60
# The planner's jobs ask for their files' colours ("force colour match").
FORCE_COLOR_KEY = "product_force_color"
# Plates printed by hand (a plate's file queued outside the planner) count:
# their pieces are stock and serve the orders. Off unless set: prints made
# beside the plan usually went into boxes the plan knows nothing about.
HAND_PRINTS_KEY = "product_hand_prints_count"
# Plates are planned with how long they really print and how often they fail
# (services/plate_history.py). On unless set to "false": then the slicer's
# times, and no plate counts as risky.
LEARN_HISTORY_KEY = "product_learn_history"
# The planner's holds on printers yield when the printer cannot take the job
# soon (services/queue_reservations.py); "false" makes them firm.
RESERVATION_YIELD_KEY = YIELD_SETTING_KEY


@dataclass(frozen=True)
class PlanSettings:
    prefer_minutes: int = DEFAULT_PREFER_MINUTES
    prefer_pct: int = DEFAULT_PREFER_PCT
    swap_minutes: int = DEFAULT_SWAP_MINUTES
    force_color: bool = True
    hand_prints_count: bool = False
    learn_history: bool = True
    reservation_yield: bool = True


def _bounded(raw: str | None, default: int, top: int) -> int:
    try:
        return max(0, min(top, int(raw))) if raw is not None else default
    except (TypeError, ValueError):
        return default


async def read_plan_settings(db: AsyncSession) -> PlanSettings:
    rows = dict(
        (
            await db.execute(
                select(Settings.key, Settings.value).where(
                    Settings.key.in_(
                        (
                            PREFER_MINUTES_KEY,
                            PREFER_PCT_KEY,
                            SWAP_MINUTES_KEY,
                            FORCE_COLOR_KEY,
                            HAND_PRINTS_KEY,
                            LEARN_HISTORY_KEY,
                            RESERVATION_YIELD_KEY,
                        )
                    )
                )
            )
        ).all()
    )
    force = rows.get(FORCE_COLOR_KEY)
    hand = rows.get(HAND_PRINTS_KEY)
    learn = rows.get(LEARN_HISTORY_KEY)
    yields = rows.get(RESERVATION_YIELD_KEY)
    return PlanSettings(
        prefer_minutes=_bounded(rows.get(PREFER_MINUTES_KEY), DEFAULT_PREFER_MINUTES, MAX_PREFER_MINUTES),
        prefer_pct=_bounded(rows.get(PREFER_PCT_KEY), DEFAULT_PREFER_PCT, 100),
        swap_minutes=_bounded(rows.get(SWAP_MINUTES_KEY), DEFAULT_SWAP_MINUTES, MAX_SWAP_MINUTES),
        force_color=True if force is None else force.strip().lower() == "true",
        hand_prints_count=hand is not None and hand.strip().lower() == "true",
        learn_history=learn is None or learn.strip().lower() != "false",
        reservation_yield=yields is None or yields.strip().lower() != "false",
    )


async def write_plan_settings(
    db: AsyncSession,
    *,
    prefer_minutes: int | None = None,
    prefer_pct: int | None = None,
    swap_minutes: int | None = None,
    force_color: bool | None = None,
    hand_prints_count: bool | None = None,
    learn_history: bool | None = None,
    reservation_yield: bool | None = None,
) -> None:
    """Store the ones given. The caller commits."""
    if prefer_minutes is not None:
        await upsert_setting(db, Settings, PREFER_MINUTES_KEY, str(max(0, min(MAX_PREFER_MINUTES, prefer_minutes))))
    if prefer_pct is not None:
        await upsert_setting(db, Settings, PREFER_PCT_KEY, str(max(0, min(100, prefer_pct))))
    if swap_minutes is not None:
        await upsert_setting(db, Settings, SWAP_MINUTES_KEY, str(max(0, min(MAX_SWAP_MINUTES, swap_minutes))))
    if force_color is not None:
        await upsert_setting(db, Settings, FORCE_COLOR_KEY, "true" if force_color else "false")
    if hand_prints_count is not None:
        await upsert_setting(db, Settings, HAND_PRINTS_KEY, "true" if hand_prints_count else "false")
    if learn_history is not None:
        await upsert_setting(db, Settings, LEARN_HISTORY_KEY, "true" if learn_history else "false")
    if reservation_yield is not None:
        await upsert_setting(db, Settings, RESERVATION_YIELD_KEY, "true" if reservation_yield else "false")


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


def counted_pieces(job: ProductJob, part_ids: set[int]) -> planner.Pieces:
    """A job's pieces as they count for stock and orders: none for a job that does not count."""
    return job_pieces(job, part_ids) if job.counted is not False else ()


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


async def products_to_replan(db: AsyncSession) -> list[int]:
    """Products the planner has work for: open orders, or waiting jobs to take out again.

    The soonest due open order first (undated after dated), so the most urgent
    product takes its places in the queue first; then by id.
    """
    due: dict[int, datetime | None] = {}
    rows = (
        await db.execute(select(ProductOrder.product_id, ProductOrder.due_date).where(ProductOrder.status == "open"))
    ).all()
    for product_id, due_date in rows:
        when = _aware(due_date)
        current = due.get(product_id)
        if product_id not in due or (when is not None and (current is None or when < current)):
            due[product_id] = when
    waiting = await db.execute(select(ProductJob.product_id).where(ProductJob.status == "planned").distinct())
    for product_id in waiting.scalars():
        due.setdefault(product_id, None)
    never = datetime.max.replace(tzinfo=timezone.utc)
    return sorted(due, key=lambda pid: (due[pid] or never, pid))


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
    """Pieces in stock now: printed (less the ones found bad), corrected, minus what done orders took.

    Pieces of jobs that do not count (plates printed by hand, see
    ``ProductJob.counted``) are left out. Done orders may have taken some of
    them already, so what is left of a part on a printer is taken to be
    theirs first: leaving them out takes stock down to zero at most, and a
    shortfall from pieces found bad later stays as it was.
    """
    part_ids = {p.id for p in product.parts}
    pool: planner.Pool = {}
    uncounted: planner.Pool = {}
    done = (
        await db.execute(select(ProductJob).where(ProductJob.product_id == product.id, ProductJob.status == "done"))
    ).scalars()
    for job in done:
        good = good_pieces(job, part_ids)
        planner.pool_add(pool, piece_printer(job), good)
        if job.counted is False:
            planner.pool_add(uncounted, piece_printer(job), good)
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
    for part_id, by_printer in uncounted.items():
        for printer_id, n in by_printer.items():
            left = pool.get(part_id, {}).get(printer_id, 0)
            theirs = min(n, max(0, left))
            if theirs:
                planner.pool_add(pool, printer_id, ((part_id, -theirs),))
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
            label = text[:24] or f"#{order.id}"
            # No title that only repeats the label (the chip would read "#1 · #1").
            title = text if text and text != label else ""
            tags[order.id] = OrderTag(order.id, label, title, due=order.due_date)
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
    ``for_stock``. A job that does not count (``ProductJob.counted``) has no
    entry.
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
        # A job that does not count prints for nothing the plan knows of: no label.
        own = sorted(
            (j for j in jobs if j.product_id == product_id and j.counted is not False),
            key=lambda j: (j.status != "printing", positions.get(j.queue_item_id or -1, 10**9), j.id),
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
    stock, so the planner prints what is missing. Not an order from Base that
    is packed already: it is gone, nothing is printed for it again.
    """
    from backend.app.services.base_sync import packed_product_orders

    def short() -> set[tuple[int, int]]:
        return {(part_id, r) for part_id, by in pool.items() for r, n in by.items() if n < 0}

    missing = short()
    if not missing:
        return []
    rows = list(
        (
            await db.execute(
                select(ProductOrder)
                .where(ProductOrder.product_id == product.id, ProductOrder.status == "done")
                .order_by(ProductOrder.completed_at.desc().nulls_last(), ProductOrder.id.desc())
            )
        ).scalars()
    )
    packed = await packed_product_orders(db, rows)
    reopened = []
    for order in rows:
        if not missing:
            break
        if order.id in packed:
            continue
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
    near = [
        r
        for r in candidates
        if r.completed_at is not None and abs((r.completed_at - job.finished_at).total_seconds()) <= 600
    ]
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
    """Take a check back: the job waits to be checked again. Returns whether a plan may change.

    It had bad pieces, or a reprint queued from the check that had not started
    (it leaves the queue). The caller replans (when so) and commits.
    """
    had_bad = bool(rejected_pieces(job))
    job.checked_at = None
    job.rejected = None
    await record_check_verdict(db, job, None)
    await db.flush()
    # A plate queued again from that check has no reason to print any more.
    removed = await remove_waiting_reprints(db, job)
    return had_bad or bool(removed)


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


# --- printing a checked plate again ---------------------------------------------

# What a reprint takes from the queue job that printed the plate: where it went
# and how it printed, not its place in the queue, its state or how it ran.
REPRINT_FIELDS = (
    "printer_id",
    "target_model",
    "target_location",
    "required_filament_types",
    "archive_id",
    "library_file_id",
    "plate_id",
    "cost_center_id",
    "project_id",
    "print_time_seconds",
    "estimated_cost",
    "ams_mapping",
    "filament_overrides",
    "nozzle_mapping",
    "nozzle_rack_choice",
    "auto_off_after",
    "gcode_injection",
    "bed_levelling",
    "flow_cali",
    "vibration_cali",
    "layer_inspect",
    "timelapse",
    "use_ams",
    "nozzle_offset_cali",
    "confirm_outcome",
    "preheat_override",
    "preheat_chamber_target_override",
)


async def reprints_of(db: AsyncSession, job_ids: list[int]) -> dict[int, ProductJob]:
    """Job id -> the newest job queued from its check to print it again (for the ones that have one)."""
    if not job_ids:
        return {}
    rows = (
        await db.execute(select(ProductJob).where(ProductJob.reprint_of_id.in_(job_ids)).order_by(ProductJob.id))
    ).scalars()
    return {job.reprint_of_id: job for job in rows if job.reprint_of_id is not None}


async def live_reprint(db: AsyncSession, job: ProductJob) -> ProductJob | None:
    """The reprint of ``job`` still waiting or printing, if any."""
    reprint = (await reprints_of(db, [job.id])).get(job.id)
    return reprint if reprint is not None and reprint.status in JOB_ACTIVE else None


async def remove_waiting_reprints(db: AsyncSession, job: ProductJob) -> int:
    """Take the reprints of ``job`` that have not started out of the queue; returns how many."""
    rows = (
        await db.execute(select(ProductJob).where(ProductJob.reprint_of_id == job.id, ProductJob.status == "planned"))
    ).scalars()
    return await _remove_waiting_jobs(db, list(rows))


async def reprint_job(
    db: AsyncSession, job: ProductJob, *, asap: bool, actor_id: int | None, manual_start: bool
) -> ProductJob:
    """Queue a finished job's plate again, first in the queue (``asap``) or last; returns the new job.

    For pieces found bad that no order brings back (a plate printed by hand).
    It goes where the queue job that printed it went (that printer, or any of
    the model), with its slots and print options; when that queue job is gone,
    to the printer that printed it. The new job counts as queued by hand, so
    plans keep it, and its pieces count when the job's did. The caller
    replans and commits.
    """
    from backend.app.api.routes.library_variants import normalize_model_name
    from backend.app.api.routes.print_queue import library_file_disk_path, printed_plate_of_multi_plate_file
    from backend.app.services.print_defaults import default_print_options
    from backend.app.services.queue_position import lock_queue_positions

    if job.status != "done":
        raise ValueError("Only a finished job can be printed again")
    product = await load_product(db, job.product_id)
    plate = next((p for p in product.plates if p.id == job.product_plate_id), None) if product else None
    if product is None or plate is None or not plate_usable(plate):
        raise ValueError("The job's plate is gone")
    pieces = plate_pieces(plate, {part.id for part in product.parts})
    if not pieces:
        raise ValueError("The job's plate prints no pieces")

    original = await db.get(PrintQueueItem, job.queue_item_id) if job.queue_item_id is not None else None
    if original is not None and (not _same_item(job, original) or not original.library_file_id):
        original = None
    if original is not None:
        fields = {name: getattr(original, name) for name in REPRINT_FIELDS}
        # The plate's file, as the planner prints it, not the archive of that run.
        fields["archive_id"] = None
        if original.target_model:
            # It went to any printer of the model: so does this one. The slots
            # were the ones of the printer that took it.
            fields.update(printer_id=None, ams_mapping=None, nozzle_mapping=None)
    else:
        library_file = plate.library_file
        target_model = None if job.printer_id is not None else normalize_model_name(plate_model(library_file))
        if job.printer_id is None and not target_model:
            raise ValueError("No printer to print the plate on")
        fields = {
            "printer_id": job.printer_id,
            "target_model": target_model,
            "library_file_id": library_file.id,
            "plate_id": plate.plate_id or printed_plate_of_multi_plate_file(library_file_disk_path(library_file)),
            "print_time_seconds": plate_duration(plate),
            **(await default_print_options(db)),
        }

    await lock_queue_positions(db)
    pending = list((await db.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars())
    if asap and pending:
        position = min(item.position or 0 for item in pending)
        for other in pending:
            if (other.position or 0) >= position:
                other.position = (other.position or 0) + 1
    else:
        position = max((item.position or 0 for item in pending), default=0) + 1
    item = PrintQueueItem(
        **fields,
        position=position,
        status="pending",
        manual_start=manual_start,
        created_by_id=actor_id,
    )
    db.add(item)
    await db.flush()
    await db.refresh(item, ["created_at"])
    reprint = ProductJob(
        product_id=product.id,
        product_plate_id=plate.id,
        queue_item_id=item.id,
        item_created_at=item.created_at,
        printer_id=item.printer_id,
        planned_printer_id=item.printer_id,
        pinned=item.printer_id is not None,
        by_hand=True,
        counted=job.counted is not False,
        status="planned",
        pieces={str(part_id): n for part_id, n in pieces},
        reprint_of_id=job.id,
    )
    db.add(reprint)
    await db.flush()
    logger.info("[PRODUCTS] Job %s printed again as queue job %s (%s)", job.id, item.id, "first" if asap else "last")
    return reprint


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


def _log_plan(
    product_id: int,
    result: planner.Plan,
    planned: list[planner.PlannedPlate],
    plates_by_id: dict[int, ProductPlate],
    skipped: list[tuple[int, str]],
) -> None:
    """One line on what the planner chose and what the other ways of packing would have cost.

    The answer to "why did it split this product over three plates": the
    packings are compared by the same cost (minutes until each order can be
    picked up, lateness, a cost per plate), see services/product_planner.
    """

    def name(plate_id: int) -> str:
        plate = plates_by_id.get(plate_id)
        filename = plate.library_file.filename if plate is not None and plate.library_file is not None else ""
        return f"{plate_id}:{filename}" if filename else str(plate_id)

    def notes(p: planner.PlannedPlate) -> str:
        text = " pinned" if p.pinned else ""
        if p.swap:
            text += f" spool {p.swap}"
        if p.preferred is not None:
            text += f" prefers {p.preferred}"
            if p.overruled:
                text += f" ({p.overruled}" + (f" {p.overruled_by_s // 60} min" if p.overruled_by_s else "") + ")"
        return text

    plates = ", ".join(
        f"{name(p.option.id)}@{p.printer_id} {p.start:%d %H:%M}-{p.end:%H:%M}{notes(p)}" for p in planned
    )
    others = ", ".join(f"{packing} {cost / 60:.0f}" for packing, cost in sorted(result.alternatives.items()))
    logger.info(
        "[PRODUCTS] Planned product %s: %s plan, cost %.0f min (by packing: %s); plates: %s%s%s",
        product_id,
        result.packing,
        result.cost / 60,
        others or "-",
        plates or "none",
        f"; short {result.short}" if result.short else "",
        f"; skipped plates {skipped}" if skipped else "",
    )


def plate_source(plate: ProductPlate) -> tuple[Path, int | None]:
    """The plate's file on disk and the plate in it a print takes."""
    from backend.app.api.routes.print_queue import library_file_disk_path, printed_plate_of_multi_plate_file

    path = library_file_disk_path(plate.library_file)
    return path, plate.plate_id or printed_plate_of_multi_plate_file(path)


async def plate_printers(
    db: AsyncSession, plates: list[ProductPlate], printer_ids: list[int]
) -> dict[int, frozenset[int] | None]:
    """Plate id -> the printers of ``printer_ids`` its file's printer tags let it go on; None for any."""
    from backend.app.services.printer_tags import NO_TAGS, read_printer_tags

    tags = await read_printer_tags(db)
    used_tags = frozenset().union(*(t.tag_ids for t in tags.values())) if tags else frozenset()
    file_tags = await _file_tag_ids(db, {plate.library_file_id for plate in plates})
    exclusive = any(t.exclusive and t.tag_ids for t in tags.values())
    result: dict[int, frozenset[int] | None] = {}
    for plate in plates:
        wanted = file_tags.get(plate.library_file_id, frozenset()) & used_tags
        result[plate.id] = (
            frozenset(pid for pid in printer_ids if tags.get(pid, NO_TAGS).accepts(wanted))
            if wanted or exclusive
            else None
        )
    return result


@dataclass
class FilamentInputs:
    # plate id -> printer id -> what the plate takes there
    use: dict[int, dict[int, tuple[planner.FilamentUse, ...]]] = field(default_factory=dict)
    # printer id -> tray -> grams left after the queued work
    left: dict[int, dict[int, float]] = field(default_factory=dict)
    margin_pct: float = 0.0


async def _filament_inputs(
    db: AsyncSession,
    inputs,
    placements: list,
    printers: list[planner.PlannerPrinter],
    options: list[planner.PlateOption],
    plates_by_id: dict[int, ProductPlate],
    settings: PlanSettings,
) -> FilamentInputs:
    """What each printer's spools hold once its queued work is done, and what each plate takes there.

    ``inputs`` is the queue forecast's inputs and ``placements`` the queue
    without this product's waiting jobs, as the plan lays it out
    (services/product_filament.py). Never fails a plan: without it the
    planner simply checks no filament.
    """
    from backend.app.services.slot_spools import load_check_settings

    try:
        spools = await product_filament.load_spools(db, [p.id for p in printers])
        if not spools:
            return FilamentInputs()
        check = await load_check_settings(db)
        left = {pid: dict(s.left) for pid, s in spools.items()}
        running = (
            await db.execute(
                select(PrintQueueItem)
                .where(PrintQueueItem.status == "printing", PrintQueueItem.printer_id.in_(list(spools)))
                .options(selectinload(PrintQueueItem.archive), selectinload(PrintQueueItem.library_file))
            )
        ).scalars()
        for item in running:
            if item.printer_id is None:  # never: the query picks them by printer
                continue
            product_filament.take(
                left[item.printer_id], product_filament.item_uses(item, item.printer_id, spools[item.printer_id])
            )
        pending = {item.id: item for item in inputs.pending}
        for placement in sorted(placements, key=lambda p: p.start):
            item = pending.get(placement.item_id)
            if item is not None and placement.printer_id in spools:
                product_filament.take(
                    left[placement.printer_id],
                    product_filament.item_uses(item, placement.printer_id, spools[placement.printer_id]),
                )
        use: dict[int, dict[int, tuple[planner.FilamentUse, ...]]] = {}
        for option in options:
            reqs = product_filament.requirements(*plate_source(plates_by_id[option.id]))
            if not reqs:
                continue
            for printer in printers:
                if printer.id in spools and option.runs_on(printer):
                    found = product_filament.match(reqs, spools[printer.id], force=settings.force_color)
                    if found:
                        use.setdefault(option.id, {})[printer.id] = found
        return FilamentInputs(use=use, left=left, margin_pct=check.margin_pct)
    except Exception as e:  # the plan goes on without filament rather than not at all
        logger.warning("[PRODUCTS] Could not weigh the filament for a plan: %s", e)
        return FilamentInputs()


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


async def waiting_jobs(db: AsyncSession, jobs: list[ProductJob]) -> list[ProductJob]:
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
    state (one that just finished). Its pieces count only when the settings
    say plates printed by hand count (``ProductJob.counted``). The caller
    commits.
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
    counts: bool | None = None
    for item, archive_file, archive_plate in rows:
        if any(
            item_id == item.id and _same_item(ProductJob(item_created_at=created), item) for item_id, created in known
        ):
            continue
        file_id = item.library_file_id or archive_file
        if file_id is None:
            continue
        plate_no = item.plate_id or archive_plate
        matches = [p for p in by_file.get(file_id, []) if p.plate_id is None or p.plate_id == plate_no]
        if len(matches) != 1:
            continue
        plate = matches[0]
        pieces: list[ProductPlatePart] = [piece for piece in plate.pieces if piece.pieces > 0]
        if not pieces:
            continue
        if counts is None:
            counts = (await read_plan_settings(db)).hand_prints_count
        job = ProductJob(
            product_id=plate.product_id,
            product_plate_id=plate.id,
            queue_item_id=item.id,
            item_created_at=item.created_at,
            printer_id=item.printer_id,
            planned_printer_id=item.printer_id,
            pinned=item.printer_id is not None,
            by_hand=True,
            counted=counts,
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
            # A hold the user released stays only so the planner does not hold the job again: no hold.
            if row.source == "released":
                continue
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
    waiting = await waiting_jobs(db, jobs)
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


async def _run_planner(inputs: planner.PlanInputs) -> planner.Plan:
    """The planner, in a worker thread: it takes seconds on a small computer,
    and MQTT and the print scheduler must not stand still meanwhile. The inputs
    are plain values (and the turnaround's functions); no database in there."""
    return await asyncio.to_thread(planner.plan, inputs)


async def replan(
    db: AsyncSession,
    product_id: int,
    *,
    actor_id: int | None,
    manual_start: bool = False,
    printer_ids: frozenset[int] | None = None,
    ignore_items: frozenset[int] = frozenset(),
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
    ``manual_start`` makes new jobs wait for someone to press Start, so the
    plan has no printer start before someone is expected there.
    The lanes include the jobs held for filament someone has to load
    (``ForecastInputs.planning_jobs``). Each plate takes the time its
    history says it really prints, and counts its chance of failing
    (services/plate_history.py; the slicer's time and no risk with
    ``PlanSettings.learn_history`` off); its queue job carries that time,
    and ``plan_info["estimate_s"]`` the slicer's. The plan's holds on
    printers are the planner's (``SOURCE_PLAN``): they yield when the
    printer cannot take the job soon (services/queue_reservations.py).
    ``ignore_items`` are queue jobs left out of the lanes the plan is made on:
    the waiting jobs of products that go behind this one (see
    ``replan_pass``), so the plan is made for the hours its place in the
    queue gives it. The planner runs in a worker thread; when one of the
    waiting jobs it was planned around started meanwhile, the plan is made
    again from the state then (up to PLAN_TRIES times; after that the started
    jobs are left alone). The caller commits.
    """
    for attempt in range(PLAN_TRIES):
        outcome = await _replan_once(
            db,
            product_id,
            actor_id=actor_id,
            manual_start=manual_start,
            printer_ids=printer_ids,
            ignore_items=ignore_items,
            last_try=attempt == PLAN_TRIES - 1,
        )
        if outcome is not None:
            return outcome
        logger.info("[PRODUCTS] Product %s: a waiting job started while it was planned, planning again", product_id)
    raise AssertionError("the last try always returns")


async def _replan_once(
    db: AsyncSession,
    product_id: int,
    *,
    actor_id: int | None,
    manual_start: bool,
    printer_ids: frozenset[int] | None,
    ignore_items: frozenset[int],
    last_try: bool,
) -> PlanOutcome | None:
    """One try of ``replan``; None when a waiting job started during the plan and it is not the last try."""
    from backend.app.services.plate_history import load_plate_history
    from backend.app.services.print_defaults import default_print_options
    from backend.app.services.queue_forecast import load_forecast_inputs, place_jobs
    from backend.app.services.queue_position import lock_queue_positions
    from backend.app.services.queue_reservations import SOURCE_PLAN, reserve

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
    waiting = await waiting_jobs(db, jobs)
    # What the plan counts as still waiting, checked again once it is made.
    planned_around = {j.queue_item_id for j in waiting if j.queue_item_id is not None}
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
        key=lambda j: (items[j.queue_item_id or -1].position or 0, j.id),
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
        planner.pool_add(coming, piece_printer(job), counted_pieces(job, part_ids))
    needed = serve_in_order(specs, coming, orders, [counted_pieces(job, part_ids) for job in held])
    unneeded = [job for job, served in zip(held, needed, strict=True) if not served and not job.by_hand]
    held = [job for job in held if job not in unneeded]
    waiting = [job for job in waiting if job not in held and job not in unneeded]
    waiting_items = {job.queue_item_id for job in waiting} | {job.queue_item_id for job in unneeded}
    # The printers someone prefers for the waiting jobs the plan replaces: the
    # plates that print them next carry the preference on.
    preferences = [
        planner.Preference(
            job.preferred_printer_id, job.product_plate_id, frozenset(pid for pid, _ in job_pieces(job, part_ids))
        )
        for job in waiting
        if job.preferred_printer_id is not None and job.product_plate_id is not None
    ]

    settings = await read_plan_settings(db)
    inputs = await load_forecast_inputs(db)
    now = inputs.now
    ready_after = inputs.ready_after
    # The lanes as they are without this product's waiting jobs (the plan
    # places them again) and without the jobs that go behind it. Jobs held
    # for filament someone has to load are on them too: once it is loaded
    # they print, and take their lane's time from then.
    others = [
        job
        for job in inputs.planning_jobs(settings.swap_minutes * 60)
        if job.id not in waiting_items and job.id not in ignore_items
    ]
    placements, _ = place_jobs(others, inputs.printers, now, ready_after)
    lane_end = {p.id: max(_aware(p.free_at) or now, now) for p in inputs.printers}
    for placement in placements:
        end = ready_after(placement.end) if ready_after is not None else placement.end
        lane_end[placement.printer_id] = max(lane_end[placement.printer_id], end)
    printer_free = {p.id: max(_aware(p.free_at) or now, now) for p in inputs.printers}

    arriving = [
        planner.Arrival(printer_free.get(job.printer_id or 0, now), piece_printer(job), counted_pieces(job, part_ids))
        for job in printing
    ]
    placed = {placement.item_id: placement for placement in placements}
    for job in held:
        placement = placed.get(job.queue_item_id or -1)
        if placement is not None:
            at = ready_after(placement.end) if ready_after is not None else placement.end
        else:
            at = lane_end.get(job.printer_id or 0, now)
        arriving.append(planner.Arrival(at, piece_printer(job), counted_pieces(job, part_ids)))

    # Printers that can take work now; when none can (all switched off for the
    # night, no Auto On plug), every enabled one, so an order still gets planned.
    usable = [p for p in inputs.printers if p.is_active and (printer_ids is None or p.id in printer_ids)]
    online = [p for p in usable if p.available]
    # New jobs that wait for someone to press Start start no sooner than
    # someone is expected there, as the forecast places them.
    starts_from = _aware(inputs.turnaround.someone_there()[0]) if manual_start else None
    printers = [
        planner.PlannerPrinter(
            p.id, model_key(p.model), max(lane_end[p.id], starts_from) if starts_from is not None else lane_end[p.id]
        )
        for p in (online or usable)
    ]

    allowed_by_plate = await plate_printers(db, product.plates, [p.id for p in printers])
    usable_plates = [plate for plate in product.plates if plate_usable(plate)]
    # The slicer's time per plate, and what the plate's history makes of it.
    estimates = {plate.id: est for plate in usable_plates if (est := plate_duration(plate)) is not None}
    history = await load_plate_history(db, usable_plates, estimates, now) if settings.learn_history else {}
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
        learned = history.get(plate.id)
        options.append(
            planner.PlateOption(
                id=plate.id,
                model=model_key(model),
                duration_s=(learned.duration_s if learned else None) or estimates.get(plate.id) or DEFAULT_DURATION_S,
                pieces=pieces,
                printers=allowed_by_plate.get(plate.id),
                risk=learned.risk if learned else 0.0,
            )
        )
        plates_by_id[plate.id] = plate

    # The jobs held for filament take none from the spools there now: they
    # wait for a spool someone loads.
    held_for_filament = {job.id for job in inputs.held}
    filament = await _filament_inputs(
        db,
        inputs,
        [p for p in placements if p.item_id not in held_for_filament],
        printers,
        options,
        plates_by_id,
        settings,
    )
    plate_cost = await read_plate_cost_minutes(db)
    result = await _run_planner(
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
            filament_use=filament.use,
            filament_left=filament.left,
            filament_margin_pct=filament.margin_pct,
            swap_s=settings.swap_minutes * 60,
            staffed_at=inputs.turnaround.next_staffed,
            preferences=preferences,
            prefer_min_s=settings.prefer_minutes * 60,
            prefer_pct=float(settings.prefer_pct),
        )
    )
    # The scheduler may have started a waiting job while the plan was made:
    # the plan counted it as waiting (to replace, or held as coming).
    still = {j.queue_item_id for j in await waiting_jobs(db, jobs)}
    if planned_around - still:
        if not last_try:
            return None
        logger.warning(
            "[PRODUCTS] Product %s: queue jobs %s started while it was planned; planned without them",
            product_id,
            sorted(planned_around - still),
        )
        # Never touched: neither kept (reserved, changed) nor taken out.
        waiting = [job for job in waiting if job.queue_item_id in still]
        unneeded = [job for job in unneeded if job.queue_item_id in still]

    def job_info(planned_plate: planner.PlannedPlate) -> dict:
        # With the slicer's estimate the plan started from: the queue job
        # carries the learned time, and the plate's history needs to know
        # which slicing a run was (plate_history.recorded_estimate).
        info = product_filament.plan_info(planned_plate)
        estimate = estimates.get(planned_plate.option.id)
        if estimate is not None:
            info["estimate_s"] = estimate
        return info

    rank = {p.id: i for i, p in enumerate(inputs.printers)}
    planned = sorted(result.plates, key=lambda p: (p.start, rank.get(p.printer_id, 0)))
    _log_plan(product.id, result, planned, plates_by_id, skipped)
    outcome = PlanOutcome(plan=result, skipped_plates=skipped, held=len(held))
    if not planned:
        outcome.replaced = await _remove_waiting_jobs(db, waiting + unneeded)
        return outcome

    from backend.app.api.routes.library_variants import normalize_model_name
    from backend.app.api.routes.print_queue import _extract_filament_types_from_3mf
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
        queue.sort(key=lambda j: (items[j.queue_item_id or -1].position or 0, j.id))

    # Where new jobs go: by the soonest due order each plate prints for,
    # against the other products' waiting jobs (the stock, the prints running
    # and the held jobs serve the orders first).
    for job in held:
        planner.pool_add(coming, piece_printer(job), counted_pieces(job, part_ids))
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
        """A position for a new job, making room for it; never at or before ``after``.

        Before the first job left out of the plan's lanes (``ignore_items``:
        it goes behind this product) or of another product due later.
        """
        for other in sorted(queue, key=lambda i: (i.position or 0, i.id)):
            at = other.position or 0
            if at > after and (
                other.id in ignore_items or (due is not None and other.id in other_dues and other_dues[other.id] > due)
            ):
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
            item = items[job.queue_item_id or -1]
            after = max(after, item.position or 0)
            job.pieces = {str(part_id): n for part_id, n in planned_plate.option.pieces}
            job.preferred_printer_id = planned_plate.preferred
            job.plan_info = job_info(planned_plate)
            # The time the plan used, so the queue's forecast agrees with it.
            if item.print_time_seconds != planned_plate.option.duration_s:
                item.print_time_seconds = planned_plate.option.duration_s
            if not pinned:
                await reserve(db, item, planned_plate.printer_id, source=SOURCE_PLAN)
            waiting.remove(job)
            outcome.kept += 1
            continue
        library_file = plate.library_file
        path, plate_id = plate_source(plate)
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
        # Asks for the file's colours: the plan counted on them, so the
        # scheduler holds the job for them rather than print another colour.
        overrides = (
            product_filament.force_color_overrides(product_filament.requirements(path, plate_id))
            if settings.force_color
            else None
        )
        item = PrintQueueItem(
            printer_id=planned_plate.printer_id if pinned else None,
            target_model=target_model,
            required_filament_types=required_types,
            filament_overrides=overrides,
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
            await reserve(db, item, planned_plate.printer_id, source=SOURCE_PLAN)
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
                preferred_printer_id=planned_plate.preferred,
                plan_info=job_info(planned_plate),
            )
        )
        outcome.item_ids.append(item.id)
    await db.flush()
    outcome.replaced = await _remove_waiting_jobs(db, waiting + unneeded)
    return outcome


@dataclass
class PassOutcome:
    """What ``replan_pass`` did."""

    # Product id -> its plan, in the order they were planned.
    outcomes: dict[int, PlanOutcome] = field(default_factory=dict)
    # Planned again though nobody asked: a more urgent product went ahead of them.
    displaced: list[int] = field(default_factory=list)
    # Products whose plan failed; they are left as they were.
    failed: list[int] = field(default_factory=list)

    @property
    def item_ids(self) -> list[int]:
        """Every queue job the pass made, for ``announce_planned``."""
        return [item_id for outcome in self.outcomes.values() for item_id in outcome.item_ids]

    def of(self, product_id: int) -> PlanOutcome:
        return self.outcomes.get(product_id) or PlanOutcome(plan=None)

    def displaced_changed(self) -> list[int]:
        """The displaced products whose plan changed the queue (new jobs, or jobs taken out)."""
        return [
            product_id
            for product_id in self.displaced
            if (outcome := self.outcomes.get(product_id)) is not None and (outcome.item_ids or outcome.replaced)
        ]

    @property
    def changed_ids(self) -> list[int]:
        """Products other screens should read again: every one planned. The asked-for ones changed
        (orders, stock), and a displaced one prints later even where it kept its jobs."""
        return sorted(self.outcomes)


@dataclass(frozen=True)
class PassReport:
    """What a pass did to products nobody asked about, for the answer to the request."""

    # (product id, name, queue jobs made, queue jobs taken out)
    also_replanned: list[tuple[int, str, int, int]]
    # (product id, name): planned again behind a more urgent one, and that plan failed.
    plan_failed: list[tuple[int, str]]


async def pass_report(db: AsyncSession, done: PassOutcome | None) -> PassReport:
    """The displaced products of ``done`` whose plan changed, and the ones whose plan failed."""
    if done is None:
        return PassReport([], [])
    changed = done.displaced_changed()
    displaced = set(done.displaced)
    failed = [p for p in done.failed if p in displaced]
    names: dict[int, str] = {}
    if changed or failed:
        rows = await db.execute(select(Product.id, Product.name).where(Product.id.in_([*changed, *failed])))
        names = dict(rows.all())
    return PassReport(
        also_replanned=[
            (p, names.get(p, f"#{p}"), len(done.outcomes[p].item_ids), done.outcomes[p].replaced) for p in changed
        ],
        plan_failed=[(p, names.get(p, f"#{p}")) for p in failed],
    )


async def replaceable_items(db: AsyncSession, product_ids: Iterable[int]) -> dict[int, frozenset[int]]:
    """Product id -> the queue jobs a replan of it is free to replace.

    Its planner's waiting jobs (planned, pending, not being sent) that were not
    queued or moved by hand: the same test ``replan`` applies to its own.
    """
    ids = list(product_ids)
    if not ids:
        return {}
    jobs = list(
        (
            await db.execute(select(ProductJob).where(ProductJob.product_id.in_(ids), ProductJob.status == "planned"))
        ).scalars()
    )
    waiting = await waiting_jobs(db, jobs)
    if not waiting:
        return {}
    items = {
        item.id: item
        for item in (
            await db.execute(select(PrintQueueItem).where(PrintQueueItem.id.in_([j.queue_item_id for j in waiting])))
        ).scalars()
    }
    placed_on = await _placed_on(db, waiting, items)
    result: dict[int, set[int]] = {}
    for job in waiting:
        item = items.get(job.queue_item_id or -1)
        if item is None or not _same_item(job, item) or job.by_hand or _moved_by_hand(job, placed_on.get(job.id)):
            continue
        result.setdefault(job.product_id, set()).add(item.id)
    return {product_id: frozenset(item_ids) for product_id, item_ids in result.items()}


async def _standing_owner(db: AsyncSession, product_id: int) -> tuple[int | None, bool, frozenset[int] | None]:
    """Whom a product's waiting jobs were planned for: (actor id, manual start, printer scope).

    For a product planned again that nobody asked about: its new jobs belong
    to whoever its waiting jobs belong to. The actor is the most common
    ``created_by_id`` of the planner's waiting jobs (None without any, or
    when the system queued them), manual start when any of them waits for it.
    """
    from backend.app.core.printer_scope import resolve_user_id_printer_scope

    waiting = [job for job in await waiting_jobs(db, await active_jobs(db, product_id)) if not job.by_hand]
    items = []
    if waiting:
        items = list(
            (
                await db.execute(
                    select(PrintQueueItem)
                    .where(PrintQueueItem.id.in_([j.queue_item_id for j in waiting]))
                    .order_by(PrintQueueItem.position, PrintQueueItem.id)
                )
            ).scalars()
        )
    owners = Counter(item.created_by_id for item in items)
    actor_id = owners.most_common(1)[0][0] if owners else None
    scope = await resolve_user_id_printer_scope(db, actor_id)
    return actor_id, any(item.manual_start for item in items), scope.printer_ids


async def replan_pass(
    db: AsyncSession,
    product_ids: Iterable[int] | None,
    *,
    actor_id: int | None,
    manual_start: bool = False,
    printer_ids: frozenset[int] | None = None,
    commit_each: bool = False,
) -> PassOutcome:
    """Plan ``product_ids`` again (None: every product with work) and the products behind them.

    Urgency is ``products_to_replan``'s order, the soonest due first. A new
    plan goes into the queue before the waiting jobs of products due later,
    so it must be made on lanes without them, and those products must be
    planned again behind it. So the pass takes the asked-for products and
    every product after the most urgent of them in that order, and plans
    them in that order, each with ``ignore_items`` = the waiting jobs of the
    pass's later products that their own replan is free to replace
    (``replaceable_items``). The most urgent product is planned on lanes
    free of the later ones' plates, the next on top of it, and so on. A
    product planned again whose plan comes out the same keeps its jobs as
    they are (``replan`` keeps a waiting job the new plan has too).

    Asked-for products are planned for the caller (``actor_id``,
    ``manual_start``, ``printer_ids``); one that fails raises. The others
    (``PassOutcome.displaced``) are planned for whoever their waiting jobs
    belong to (``_standing_owner``), each in a savepoint: one that fails is
    logged, left as it was and listed in ``PassOutcome.failed``. With
    ``commit_each`` every product is committed on its own, and any that
    fails is rolled back and listed instead of raising. Otherwise the
    caller commits.
    """
    order = await products_to_replan(db)
    asked = set(order) if product_ids is None else set(product_ids)
    if not asked:
        return PassOutcome()
    # Asked-for products with nothing to plan still get their replan (it
    # closes ready orders, takes leftover jobs out); last, they wait for nothing.
    order += sorted(asked - set(order))
    first = next(index for index, product_id in enumerate(order) if product_id in asked)
    in_pass = order[first:]
    replaceable = await replaceable_items(db, in_pass)
    result = PassOutcome()
    for index, product_id in enumerate(in_pass):
        behind = frozenset().union(*(replaceable.get(later, frozenset()) for later in in_pass[index + 1 :]))
        mine = product_id in asked
        if not mine:
            result.displaced.append(product_id)

        async def plan_it(product_id: int = product_id, mine: bool = mine, behind: frozenset[int] = behind):
            owner = (actor_id, manual_start, printer_ids) if mine else await _standing_owner(db, product_id)
            return await replan(
                db, product_id, actor_id=owner[0], manual_start=owner[1], printer_ids=owner[2], ignore_items=behind
            )

        if commit_each:
            try:
                outcome = await plan_it()
                await db.commit()
            except Exception:
                await db.rollback()
                logger.exception("[PRODUCTS] Could not replan product %s", product_id)
                result.failed.append(product_id)
                continue
        elif mine:
            outcome = await plan_it()
        else:
            try:
                async with db.begin_nested():
                    outcome = await plan_it()
            except Exception:
                logger.exception("[PRODUCTS] Could not replan product %s behind a more urgent one", product_id)
                result.failed.append(product_id)
                continue
        result.outcomes[product_id] = outcome
    if result.displaced:
        logger.info(
            "[PRODUCTS] Replanned products %s behind %s, the more urgent",
            result.displaced,
            sorted(p for p in in_pass if p in asked),
        )
    return result


async def announce_replanned(product_ids: Iterable[int]) -> None:
    """Tell every client which products were planned again, after the caller's commit.

    One ``products_replanned`` message, so other screens read them again now
    instead of at their next poll. Never raises: a request must not fail for it.
    """
    ids = sorted(set(product_ids))
    if not ids:
        return
    try:
        from backend.app.core.websocket import ws_manager

        await ws_manager.broadcast({"type": "products_replanned", "product_ids": ids})
    except Exception as e:
        logger.warning("[PRODUCTS] Could not announce replanned products %s: %s", ids, e)


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


@dataclass
class PlateChoice:
    """A printer a job's plate may be preferred on: enabled, of the file's model, allowed by its tags."""

    printer_id: int
    name: str
    # Can take work now (connected, or an Auto On plug wakes it).
    available: bool


@dataclass
class OrderPlate:
    """A plate the plan prints for an order: where and when, and the printers it may be preferred on."""

    job: ProductJob
    product: Product
    plate: ProductPlate | None
    status: str
    printer_id: int | None
    start: datetime | None
    end: datetime | None
    moved: bool
    choices: list[PlateChoice]
    orders: list[OrderTag]


async def order_plates(db: AsyncSession, product_order_ids: set[int]) -> list[OrderPlate]:
    """The planner's waiting and printing jobs that print for these product orders, the printing first.

    Where a waiting job prints and when is the queue forecast's, as the
    planner sees it (a job held for filament starts once someone has loaded
    it), so it agrees with ``order_estimates``; a printing one's end is its
    printer's.
    """
    from backend.app.models.printer import Printer
    from backend.app.services.queue_forecast import build_queue_forecast

    if not product_order_ids:
        return []
    by_item, _ = await order_tags(db)
    item_ids = [
        item_id
        for item_id, entry in by_item.items()
        if any(tag.product_order_id in product_order_ids for tag in entry.orders)
    ]
    if not item_ids:
        return []
    jobs = list(
        (
            await db.execute(
                select(ProductJob).where(ProductJob.queue_item_id.in_(item_ids), ProductJob.status.in_(JOB_ACTIVE))
            )
        ).scalars()
    )
    forecast = await build_queue_forecast(db)
    placed = {p.item_id: p for p in forecast.planning_placements}
    free_at = {p.printer_id: p.free_at for p in forecast.printers}
    available = {p.printer_id: p.available for p in forecast.printers}
    printers = list((await db.execute(select(Printer).order_by(Printer.id))).scalars())
    placed_on, moved = await placed_by_hand(db, jobs)
    products: dict[int, Product] = {}
    result = []
    for job in jobs:
        if job.product_id not in products:
            loaded = await load_product(db, job.product_id)
            if loaded is None:
                continue
            products[job.product_id] = loaded
        product = products[job.product_id]
        plate = next((p for p in product.plates if p.id == job.product_plate_id), None)
        choices: list[PlateChoice] = []
        if plate is not None and plate.library_file is not None:
            model = model_key(plate_model(plate.library_file))
            allowed = (await plate_printers(db, [plate], [p.id for p in printers])).get(plate.id)
            choices = [
                PlateChoice(p.id, p.name, bool(available.get(p.id)))
                for p in printers
                if p.is_active and model and model_key(p.model) == model and (allowed is None or p.id in allowed)
            ]
        if job.status == "printing":
            printer_id, start, end = job.printer_id, None, free_at.get(job.printer_id or 0)
        else:
            placement = placed.get(job.queue_item_id or -1)
            if placement is not None:
                printer_id, start, end = placement.printer_id, placement.start, placement.end
            else:
                printer_id, start, end = placed_on.get(job.id, job.printer_id), None, None
        result.append(
            OrderPlate(
                job=job,
                product=product,
                plate=plate,
                status=job.status,
                printer_id=printer_id,
                start=start,
                end=end,
                moved=job.id in moved,
                choices=choices,
                orders=by_item[job.queue_item_id or -1].orders,
            )
        )
    far = datetime.max.replace(tzinfo=timezone.utc)
    result.sort(key=lambda p: (p.status != "printing", _aware(p.start) or far, p.job.id))
    return result


async def planned_times(db: AsyncSession, jobs: list[ProductJob]) -> dict[int, tuple[int | None, bool]]:
    """Job id -> (the time the plan used for it, whether that time was learned).

    The plan's time is its queue job's ``print_time_seconds``. Learned: it came
    from the plate's history (the planner recorded the slicer's estimate with
    the job, ``plan_info["estimate_s"]``) and differs from that estimate.
    """
    from backend.app.services.plate_history import recorded_estimate

    ids = [job.queue_item_id for job in jobs if job.queue_item_id is not None]
    times: dict[int, int | None] = {}
    if ids:
        rows = await db.execute(
            select(PrintQueueItem.id, PrintQueueItem.print_time_seconds).where(PrintQueueItem.id.in_(ids))
        )
        times = dict(rows.all())
    result = {}
    for job in jobs:
        planned = times.get(job.queue_item_id or -1)
        estimate = recorded_estimate(job.plan_info)
        learned = planned is not None and estimate is not None and not job.by_hand and planned != estimate
        result[job.id] = (planned, learned)
    return result


# Why an open order has no estimate (see ``order_forecast``).
NO_PRINTER = "no_printer"
HELD = "held"
NOTHING_QUEUED = "nothing_queued"


async def order_estimates(
    db: AsyncSession, product: Product, pool: planner.Pool, orders: list[ProductOrder], forecast=None
) -> dict[int, datetime | None]:
    """When each open order is expected to be ready, from the queue forecast (built when not given).

    The forecast as the planner sees it: a job held for filament prints once
    someone has loaded it (``QueueForecast.planning_placements``).
    """
    return (await order_forecast(db, product, pool, orders, forecast))[0]


async def order_forecast(
    db: AsyncSession, product: Product, pool: planner.Pool, orders: list[ProductOrder], forecast=None
) -> tuple[dict[int, datetime | None], dict[int, str | None]]:
    """``order_estimates``, and for each open order why it has none (None when it has one).

    ``nothing_queued``: no waiting or printing job serves it, or the ones that
    do are all placed and it still lacks pieces; ``no_printer``: a waiting job
    serving it is one the forecast places on no printer (none can take it
    now); ``held``: a waiting job serving it is held for something else (its
    waiting reason, not started yet, no model). Which jobs serve which order is
    ``serve_in_order``'s answer, the jobs in the order they print. ``orders``
    are in ``open_orders``' order.
    """
    if not orders:
        return {}, {}
    from backend.app.services.queue_forecast import build_queue_forecast

    if forecast is None:
        forecast = await build_queue_forecast(db)
    now = forecast.generated_at
    ready_after = forecast.turnaround.as_function() if forecast.turnaround is not None else None
    placed = {p.item_id: p for p in forecast.planning_placements}
    free_at = {p.printer_id: _aware(p.free_at) or now for p in forecast.printers}
    part_ids = {p.id for p in product.parts}
    specs = part_specs(product)
    arrivals = planner.stock_arrivals(pool, now)
    jobs = await active_jobs(db, product.id)
    for job in jobs:
        pieces = counted_pieces(job, part_ids)
        if job.status == "printing":
            arrivals.append(
                planner.Arrival(max(free_at.get(job.printer_id or 0, now), now), piece_printer(job), pieces)
            )
        elif job.queue_item_id in placed:
            p = placed[job.queue_item_id]
            ready = ready_after(p.end) if ready_after is not None else p.end
            arrivals.append(planner.Arrival(max(ready, p.end), p.printer_id, pieces))
    ready_at = planner.ready_times(specs, needs_of(orders), arrivals, now)
    reasons: dict[int, str | None] = {order.id: None for order in orders}
    if all(ready_at.get(order.id) is not None for order in orders):
        return ready_at, reasons

    # The jobs in the queue (printing, or a pending queue job the forecast read), in the order they print.
    off = {entry.item_id: entry.reason for entry in forecast.off_timeline}
    positions = {item_id: item.position or 0 for item_id, item in forecast.items.items()}
    queued = sorted(
        (
            job
            for job in jobs
            if job.counted is not False and (job.status == "printing" or job.queue_item_id in forecast.items)
        ),
        key=lambda j: (
            j.status != "printing",
            positions.get(j.queue_item_id or -1, 0),
            j.id,
        ),
    )
    serving = serve_in_order(specs, pool, orders, [job_pieces(job, part_ids) for job in queued])
    for order in orders:
        if ready_at.get(order.id) is not None:
            continue
        unplaced = [
            job
            for job, served in zip(queued, serving, strict=True)
            if order in served and job.status != "printing" and job.queue_item_id not in placed
        ]
        if not unplaced:
            reasons[order.id] = NOTHING_QUEUED
        elif any(off.get(job.queue_item_id or -1, "no_printer") == "no_printer" for job in unplaced):
            reasons[order.id] = NO_PRINTER
        else:
            reasons[order.id] = HELD
    return ready_at, reasons


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
        source = next(items[j.queue_item_id or -1] for j in started if j.product_id == product_id)
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
            done = await replan_pass(
                db, [product_id], actor_id=actor_id, manual_start=manual_start, printer_ids=scope.printer_ids
            )
            await db.commit()
        await announce_planned(done.item_ids)
        await announce_replanned(done.changed_ids)
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
