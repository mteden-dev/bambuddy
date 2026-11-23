"""Where and when the scheduler is expected to run each pending queue item (fork).

The queue timeline draws one lane per printer. A job pinned to a printer has its
lane; a job for "Any <model>" has none until it starts, so the timeline used to
leave it off and showed an idle printer next to a full queue. This replays the
scheduler ahead of time: whenever a printer becomes free it takes the first job,
in dispatch order, that may run on it, as ``PrintScheduler.check_queue`` does.

It is a forecast, not a reservation. The scheduler decides again at every pass,
and it also gates on things this does not model (loaded filament, nozzle, the
plate-clear prompt, a printer's last print failing). Jobs held for one of those
reasons carry a waiting reason, and like the timeline before, they are left off
the lanes and listed apart with that reason.

``placement_refusal`` is the one answer to "may this job go on that printer",
for the forecast's "Any" jobs and for the timeline's drag and drop alike.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.printer_scope import PrinterScope, resolve_user_id_printer_scope
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.utils.printer_models import is_gcode_compatible, normalize_printer_model

ACTIVE_PRINT_STATES = ("RUNNING", "PAUSE", "PREPARE", "SLICING")
# Stand-in for a job whose file gives no print time, and for a running print that
# reports neither a remaining time nor a duration (the timeline used the same).
DEFAULT_DURATION_S = 3600


@dataclass(frozen=True)
class Refusal:
    """Why a job may not go on a printer.

    ``code`` is one of: ``inactive`` (printer disabled), ``model`` (the file is
    for another model; ``detail`` names it), ``location`` (the job is limited to
    a location; ``detail`` names it), ``alternatives`` (a job with printer
    alternatives picks its printer itself), ``scope`` (outside the creator's
    printers) or ``tags`` (printer tags; ``detail`` says which).
    """

    code: str
    detail: str | None = None


@dataclass
class ForecastPrinter:
    id: int
    model: str | None
    location: str | None = None
    is_active: bool = True
    # Can take work: connected now, or an Auto On plug can power it up (#2786).
    available: bool = True
    # When it is done with what it runs now; None (or the past) when idle.
    free_at: datetime | None = None


@dataclass
class ForecastJob:
    id: int
    printer_id: int | None = None
    target_model: str | None = None
    target_location: str | None = None
    sliced_for: str | None = None
    # Models of the printer alternatives (#671); empty for an ordinary job.
    variant_models: tuple[str, ...] = ()
    scheduled_time: datetime | None = None
    duration_s: int = DEFAULT_DURATION_S
    # Printers rules outside this module refuse it on, such as printer tags.
    blocked: Mapping[int, Refusal] = field(default_factory=dict)
    # The printers its creator may use, for an "Any" job (#1727); None for all.
    allowed_printers: frozenset[int] | None = None


@dataclass
class Placement:
    item_id: int
    printer_id: int
    start: datetime
    end: datetime
    # Chosen by the forecast for an "Any" job, not pinned there by the user.
    projected: bool


def _model_key(model: str | None) -> str:
    return (normalize_printer_model(model) or model or "").strip().lower()


def placement_refusal(job: ForecastJob, printer: ForecastPrinter, *, exact_model: bool) -> Refusal | None:
    """Why ``job`` may not run on ``printer``, or None when it may.

    ``exact_model`` picks the model rule. True is the scheduler's rule for an
    "Any <model>" job: the printer is that model (or one of the alternatives'
    models). False is the rule for pinning the job to the printer, as a drop on
    the timeline does: G-code sliced for the file's model must suit the printer
    (#2578), so a P1S file may go on an X1C but not on an H2D.
    """
    if not printer.is_active:
        return Refusal("inactive")
    if exact_model:
        if job.allowed_printers is not None and printer.id not in job.allowed_printers:
            return Refusal("scope")
        models = job.variant_models or ((job.target_model,) if job.target_model else ())
        if _model_key(printer.model) not in {_model_key(m) for m in models}:
            return Refusal("model", " / ".join(models) or None)
    else:
        if job.variant_models:
            return Refusal("alternatives")
        wanted = job.sliced_for or job.target_model
        if not is_gcode_compatible(wanted, printer.model):
            return Refusal("model", wanted)
    if job.target_location and (printer.location or "") != job.target_location:
        return Refusal("location", job.target_location)
    return job.blocked.get(printer.id)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def place_jobs(
    jobs: list[ForecastJob], printers: list[ForecastPrinter], now: datetime
) -> tuple[list[Placement], list[int]]:
    """Place ``jobs`` on ``printers`` the way the scheduler would take them.

    ``jobs`` come in dispatch order and ``printers`` in the order an "Any" job
    picks among free ones (Settings > Queue > printer order). Whichever printer
    is free first takes the first job that may run on it and whose scheduled
    time has come; ties go to the printer earlier in that order. A pinned job
    waits for its printer even when the printer is offline, so it stays on its
    lane; an "Any" job only counts printers that can take work.

    Returns the placements and the ids of "Any" jobs no printer can take.
    """
    rank = {p.id: i for i, p in enumerate(printers)}
    free_at = {p.id: max(_aware(p.free_at) or now, now) for p in printers}
    takers: dict[int, set[int]] = {}
    unplaced: list[int] = []
    for job in jobs:
        if job.printer_id is not None:
            ids = {job.printer_id} if job.printer_id in rank else set()
        else:
            ids = {p.id for p in printers if p.available and placement_refusal(job, p, exact_model=True) is None}
        if ids:
            takers[job.id] = ids
        elif job.printer_id is None:
            unplaced.append(job.id)

    waiting = [job for job in jobs if job.id in takers]
    open_printers = set().union(*takers.values()) if takers else set()
    placements: list[Placement] = []
    while waiting and open_printers:
        printer_id = min(open_printers, key=lambda pid: (free_at[pid], rank[pid]))
        t = free_at[printer_id]
        fits = [job for job in waiting if printer_id in takers[job.id]]
        if not fits:
            open_printers.discard(printer_id)
            continue
        ready = next((job for job in fits if (_aware(job.scheduled_time) or t) <= t), None)
        if ready is None:
            # Only jobs scheduled for later fit: the printer idles until the first.
            free_at[printer_id] = min(_aware(job.scheduled_time) for job in fits)  # type: ignore[type-var]
            continue
        end = t + timedelta(seconds=ready.duration_s)
        placements.append(Placement(ready.id, printer_id, t, end, projected=ready.printer_id is None))
        free_at[printer_id] = end
        waiting.remove(ready)
    return placements, unplaced


@dataclass
class OffTimeline:
    """A pending job the forecast does not place, and why."""

    item_id: int
    # manual_start | waiting | no_printer | unassigned | starting
    reason: str
    detail: str | None = None


@dataclass
class PrinterForecast:
    printer_id: int
    free_at: datetime
    available: bool
    connected: bool
    # Printing something that is not a queue job (started on the printer or in a slicer).
    external_print: bool
    awaiting_plate_clear: bool


@dataclass
class QueueForecast:
    generated_at: datetime
    placements: list[Placement]
    off_timeline: list[OffTimeline]
    printers: list[PrinterForecast]
    # item id -> printer id -> why the job may not be moved onto that printer
    refusals: dict[int, dict[int, Refusal]]
    # Every pending job the forecast looked at, to filter by what the caller may read.
    items: dict[int, PrintQueueItem]


def _dispatch_order_key(sjf_enabled: bool):
    """The order of ``check_queue``'s query, as a sort key."""

    def key(item: PrintQueueItem):
        position = (item.position or 0, item.id)
        if not sjf_enabled:
            return position
        duration = item.print_time_seconds
        return (not item.been_jumped, duration is None, duration or 0, *position)

    return key


def _is_busy_only(reason: str) -> bool:
    return all(part.strip().startswith("Busy:") for part in reason.split(" | "))


# The scheduler's wording for a pinned job whose printer waits for someone to
# confirm the plate is clear (PrintScheduler._pinned_hold_reason).
_PLATE_HOLD_PREFIX = "Waiting for plate confirmation:"


def _waits_only_for_its_plate(item: PrintQueueItem) -> bool:
    """A pinned job held only until its own printer's plate is confirmed clear.

    It keeps its place on that printer's lane, which the timeline marks "Plate
    to clear": once the plate is confirmed it runs there, in dispatch order with
    the "Any" jobs forecast onto the same printer. Listing it apart left the
    lane showing other jobs than the printer card's "Next in queue".
    """
    reason = item.waiting_reason or ""
    return item.printer_id is not None and all(
        part.strip().startswith(("Busy:", _PLATE_HOLD_PREFIX)) for part in reason.split(" | ")
    )


def _sliced_for(item: PrintQueueItem) -> str | None:
    if item.archive is not None:
        return item.archive.sliced_for_model
    if item.library_file is not None and item.library_file.file_metadata:
        return item.library_file.file_metadata.get("sliced_for_model")
    return None


async def build_queue_forecast(db: AsyncSession, now: datetime | None = None) -> QueueForecast:
    """Forecast the whole queue on every printer, from the database and live printer state."""
    # Imported here: the scheduler module pulls in much of the app at import time.
    from backend.app.services.print_scheduler import _order_printers, scheduler
    from backend.app.services.printer_manager import printer_manager
    from backend.app.services.printer_tags import TagRouting

    now = now or datetime.now(timezone.utc)

    printers = list((await db.execute(select(Printer).order_by(Printer.id))).scalars().all())
    order = await scheduler._get_model_dispatch_order(db)
    last_finished = None
    if order == "least_recently_used" and printers:
        last_finished = await scheduler._last_finished_by_printer(db, [p.id for p in printers])
    printers = _order_printers(printers, order, last_finished)
    wakeable = await scheduler._wakeable_printer_ids(db)
    sjf_enabled = await scheduler._get_bool_setting(db, "queue_shortest_first")

    rows = (
        (
            await db.execute(
                select(PrintQueueItem)
                .where(PrintQueueItem.status.in_(("pending", "printing")))
                .options(
                    selectinload(PrintQueueItem.archive),
                    selectinload(PrintQueueItem.library_file),
                    selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file),
                )
            )
        )
        .scalars()
        .all()
    )
    printing = {item.printer_id: item for item in rows if item.status == "printing" and item.printer_id is not None}
    pending = sorted((item for item in rows if item.status == "pending"), key=_dispatch_order_key(sjf_enabled))
    routing = await TagRouting.load(db, pending)

    forecast_printers: list[ForecastPrinter] = []
    printer_states: list[PrinterForecast] = []
    for printer in printers:
        state = printer_manager.get_status(printer.id)
        connected = printer_manager.is_connected(printer.id)
        running = printing.get(printer.id)
        busy = state is not None and state.state in ACTIVE_PRINT_STATES
        free_at = now
        if running is not None or busy:
            if state is not None and state.remaining_time and state.remaining_time > 0:
                free_at = now + timedelta(minutes=state.remaining_time)
            elif running is not None and running.print_time_seconds:
                progress = state.progress if state is not None else 0
                remaining = running.print_time_seconds * max(0.0, 1 - (progress or 0) / 100)
                free_at = now + timedelta(seconds=remaining)
            else:
                free_at = now + timedelta(seconds=DEFAULT_DURATION_S)
        available = connected or printer.id in wakeable
        forecast_printers.append(
            ForecastPrinter(
                id=printer.id,
                model=printer.model,
                location=printer.location,
                is_active=bool(printer.is_active),
                available=available,
                free_at=free_at,
            )
        )
        printer_states.append(
            PrinterForecast(
                printer_id=printer.id,
                free_at=free_at,
                available=available,
                connected=connected,
                external_print=busy and running is None,
                awaiting_plate_clear=printer_manager.is_awaiting_plate_clear(printer.id),
            )
        )

    creator_scopes: dict[int | None, PrinterScope] = {}
    jobs: dict[int, ForecastJob] = {}
    schedulable: list[ForecastJob] = []
    off_timeline: list[OffTimeline] = []
    for item in pending:
        variant_models = tuple(v.target_model for v in item.variants if v.target_model)
        allowed = None
        if item.printer_id is None:
            if item.created_by_id not in creator_scopes:
                creator_scopes[item.created_by_id] = await resolve_user_id_printer_scope(db, item.created_by_id)
            allowed = creator_scopes[item.created_by_id].printer_ids
        blocked = {}
        for printer in forecast_printers:
            refusal = routing.refusal(item, printer.id)
            if refusal is not None:
                blocked[printer.id] = Refusal(refusal["code"], refusal.get("detail"))
        job = ForecastJob(
            id=item.id,
            printer_id=item.printer_id,
            target_model=item.target_model,
            target_location=item.target_location or None,
            sliced_for=_sliced_for(item),
            variant_models=variant_models,
            scheduled_time=item.scheduled_time,
            duration_s=item.print_time_seconds or DEFAULT_DURATION_S,
            blocked=blocked,
            allowed_printers=allowed,
        )
        jobs[item.id] = job

        if item.dispatching_at is not None and item.printer_id is None:
            off_timeline.append(OffTimeline(item.id, "starting"))
        elif item.manual_start:
            off_timeline.append(OffTimeline(item.id, "manual_start"))
        elif item.waiting_reason and not _is_busy_only(item.waiting_reason) and not _waits_only_for_its_plate(item):
            off_timeline.append(OffTimeline(item.id, "waiting", item.waiting_reason))
        elif item.printer_id is None and not item.target_model and not variant_models:
            off_timeline.append(OffTimeline(item.id, "unassigned"))
        else:
            schedulable.append(job)

    placements, unplaced = place_jobs(schedulable, forecast_printers, now)
    off_timeline.extend(OffTimeline(item_id, "no_printer") for item_id in unplaced)

    refusals: dict[int, dict[int, Refusal]] = {}
    for item_id, job in jobs.items():
        per_printer = {
            printer.id: refusal
            for printer in forecast_printers
            if (refusal := placement_refusal(job, printer, exact_model=False)) is not None
        }
        if per_printer:
            refusals[item_id] = per_printer

    return QueueForecast(
        generated_at=now,
        placements=placements,
        off_timeline=off_timeline,
        printers=printer_states,
        refusals=refusals,
        items={item.id: item for item in pending},
    )
