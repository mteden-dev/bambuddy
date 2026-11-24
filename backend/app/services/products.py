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
  stock is corrected, on request, and when one of its prints fails. Nothing
  else rewrites the planner's jobs.

``after_queue_items_changed`` is called where print batches are refreshed
(services/print_batch.py), so a job's row follows its queue job there.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete, select
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
                selectinload(Product.plates).selectinload(ProductPlate.pieces),
                selectinload(Product.plates).selectinload(ProductPlate.library_file),
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


def part_specs(product: Product) -> list[planner.PartSpec]:
    return [planner.PartSpec(p.id, max(1, p.quantity or 1), bool(p.matched)) for p in product.parts]


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


# --- stock and orders ------------------------------------------------------------


async def stock_pool(db: AsyncSession, product: Product) -> planner.Pool:
    """Pieces in stock now: printed, corrected, minus what done orders took."""
    part_ids = {p.id for p in product.parts}
    pool: planner.Pool = {}
    done = (
        await db.execute(select(ProductJob).where(ProductJob.product_id == product.id, ProductJob.status == "done"))
    ).scalars()
    for job in done:
        planner.pool_add(pool, job.printer_id or planner.UNKNOWN_PRINTER, job_pieces(job, part_ids))
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


async def refresh_product(db: AsyncSession, product: Product) -> tuple[planner.Pool, list[ProductJob]]:
    """Follow the queue and close finished orders; returns the stock and the jobs that just failed."""
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
    # Waiting jobs it replaced.
    replaced: int = 0
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


async def replan(
    db: AsyncSession,
    product_id: int,
    *,
    actor_id: int | None,
    manual_start: bool = False,
    printer_ids: frozenset[int] | None = None,
) -> PlanOutcome:
    """Plan the product's open orders again and put the plates in the queue.

    The planner's waiting jobs are replaced; started ones stay and count as
    coming. ``printer_ids`` limits the printers (the user's printer scope);
    ``manual_start`` makes the new jobs wait for someone to press Start. The
    caller commits.
    """
    from backend.app.services.print_defaults import default_print_options
    from backend.app.services.printer_tags import NO_TAGS, read_printer_tags
    from backend.app.services.queue_forecast import load_forecast_inputs, place_jobs
    from backend.app.services.queue_position import lock_queue_positions, max_queue_position
    from backend.app.services.queue_reservations import reserve

    product = await load_product(db, product_id)
    if product is None:
        return PlanOutcome(plan=None)
    jobs = await active_jobs(db, product.id)
    await sync_jobs(db, jobs)
    replaced = await _remove_waiting_jobs(db, jobs)
    pool = await stock_pool(db, product)
    await complete_ready_orders(db, product, pool)
    orders = await open_orders(db, product.id)
    jobs = await active_jobs(db, product.id)

    inputs = await load_forecast_inputs(db)
    now = inputs.now
    ready_after = inputs.ready_after
    placements, _ = place_jobs(inputs.schedulable, inputs.printers, now, ready_after)
    lane_end = {p.id: max(_aware(p.free_at) or now, now) for p in inputs.printers}
    for placement in placements:
        end = ready_after(placement.end) if ready_after is not None else placement.end
        lane_end[placement.printer_id] = max(lane_end[placement.printer_id], end)
    printer_free = {p.id: max(_aware(p.free_at) or now, now) for p in inputs.printers}

    part_ids = {p.id for p in product.parts}
    arriving = [
        planner.Arrival(
            printer_free.get(job.printer_id or 0, now),
            job.printer_id or planner.UNKNOWN_PRINTER,
            job_pieces(job, part_ids),
        )
        for job in jobs
        if job.status == "printing"
    ]

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
            parts=part_specs(product),
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
    outcome = PlanOutcome(plan=result, replaced=replaced, skipped_plates=skipped)
    if not planned:
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
    position = await max_queue_position(db) + 1
    filament_types: dict[tuple[int, int | None], list[str]] = {}
    for planned_plate in planned:
        plate = plates_by_id[planned_plate.option.id]
        library_file = plate.library_file
        path = library_file_disk_path(library_file)
        plate_id = plate.plate_id or printed_plate_of_multi_plate_file(path)
        pinned = planned_plate.pinned
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
            position=position,
            status="pending",
            created_by_id=actor_id,
            **defaults,
        )
        position += 1
        db.add(item)
        await db.flush()
        await db.refresh(item, ["created_at"])
        if not pinned:
            await reserve(db, item, planned_plate.printer_id)
        db.add(
            ProductJob(
                product_id=product.id,
                product_plate_id=plate.id,
                queue_item_id=item.id,
                item_created_at=item.created_at,
                printer_id=planned_plate.printer_id,
                pinned=pinned,
                status="planned",
                pieces={str(part_id): n for part_id, n in planned_plate.option.pieces},
            )
        )
        outcome.item_ids.append(item.id)
    await db.flush()
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
    db: AsyncSession, product: Product, pool: planner.Pool, orders: list[ProductOrder]
) -> dict[int, datetime | None]:
    """When each open order is expected to be ready, from the queue forecast."""
    if not orders:
        return {}
    from backend.app.services.queue_forecast import build_queue_forecast

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
                planner.Arrival(max(free_at.get(job.printer_id or 0, now), now), job.printer_id or 0, pieces)
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
    """Follow queue jobs the planner made; replan a product whose print failed.

    Called where print batches are refreshed, in the caller's session; changes
    are left for the caller to commit. The replan runs afterwards, in its own
    session, acting for whoever queued the failed job. Only a print that
    started counts: a job the printer never started (the scheduler gives up
    after its retries) is left for someone to look at, as is a product whose
    prints keep failing (AUTO_REPLAN_LIMIT).
    """
    if not queue_item_ids:
        return
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
    started = [j for j in failed if (item := items.get(j.queue_item_id or -1)) is not None and item.started_at]
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
        logger.info("[PRODUCTS] Replanned product %s after a failed print", product_id)
    except Exception as e:
        logger.warning("[PRODUCTS] Could not replan product %s after a failed print: %s", product_id, e)
