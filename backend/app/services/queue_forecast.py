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

A job that waits for someone to press Start goes on the lanes from when someone
is expected to be there (``PlateTurnaround.someone_there``): like a job
scheduled for later, it holds back no job behind it until then.

A job the product planner reserved holds its printer only softly, as the
scheduler keeps to it (services/queue_reservations.py): another printer may take
it once its own is further off than the margin.

The product planner plans with the jobs held for filament someone has to load
as well (``ForecastInputs.planning_jobs``, ``QueueForecast.planning_placements``):
they start soon after someone is there, and take lane time from then. The
timeline itself still lists them apart.

``placement_refusal`` is the one answer to "may this job go on that printer",
for the forecast's "Any" jobs and for the timeline's drag and drop alike.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.printer_scope import PrinterScope, resolve_user_id_printer_scope
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.utils.printer_models import is_gcode_compatible, normalize_printer_model

if TYPE_CHECKING:
    from backend.app.services.staffed_hours import PlateTurnaround

ACTIVE_PRINT_STATES = ("RUNNING", "PAUSE", "PREPARE", "SLICING")
# Stand-in for a job whose file gives no print time, and for a running print that
# reports neither a remaining time nor a duration (the timeline used the same).
DEFAULT_DURATION_S = 3600
# For planning: how long someone takes to load the filament a held job waits for.
HELD_SWAP_S = 600

# The scheduler's wording for a job no printer has the filament for
# (PrintScheduler._find_idle_printer_for_model): a printer lacks a type or a
# colour, or the slot matcher cannot fill a slot on it. A printer is named
# there only once it passed every other check (nozzle, scope, model), so
# loading the filament lets the job start, whatever else the reason says
# about other printers or alternatives.
_FILAMENT_WAIT_MARKERS = ("Waiting for filament:", "No matching material/color.")


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


@dataclass(frozen=True)
class ForecastVariant:
    """One printer alternative of a job (#671): the file it prints on a model."""

    library_file_id: int
    model: str
    duration_s: int | None = None
    # For the timeline: the file's print name (or file name), plate and thumbnail.
    name: str | None = None
    plate_id: int | None = None
    has_thumbnail: bool = False


@dataclass
class ForecastJob:
    id: int
    printer_id: int | None = None
    target_model: str | None = None
    target_location: str | None = None
    sliced_for: str | None = None
    # Models of the printer alternatives (#671); empty for an ordinary job.
    variant_models: tuple[str, ...] = ()
    # The alternatives in the order the scheduler tries them, to tell which file
    # (and print time) a printer gets.
    variants: tuple[ForecastVariant, ...] = ()
    scheduled_time: datetime | None = None
    # Waits for someone to press Start: not before someone is expected there.
    manual_start_from: datetime | None = None
    duration_s: int = DEFAULT_DURATION_S
    # Printers rules outside this module refuse it on, such as printer tags.
    blocked: Mapping[int, Refusal] = field(default_factory=dict)
    # The printers its creator may use, for an "Any" job (#1727); None for all.
    allowed_printers: frozenset[int] | None = None
    # The printer the timeline's plan holds this "Any" job for, while that holds
    # (services/queue_reservations.py): like a pinned job, it waits for it.
    reserved_printer_id: int | None = None
    # The product planner's hold: another printer may take the job while its
    # own is further off than ``yield_margin_s``.
    reservation_soft: bool = False
    yield_margin_s: float = 0.0


@dataclass
class Placement:
    item_id: int
    printer_id: int
    start: datetime
    end: datetime
    # Chosen by the forecast for an "Any" job, not pinned there by the user.
    projected: bool
    # For a job with alternatives: the one this printer's model takes.
    variant: ForecastVariant | None = None
    # Held for this printer by the timeline's plan (or the product planner).
    reserved: bool = False


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


def reservation_refusal(job: ForecastJob, printer: ForecastPrinter) -> Refusal | None:
    """Why the timeline's plan may not hold "Any" ``job`` for ``printer``.

    The scheduler's rule for an "Any" job, which is what keeps it there, plus a
    printer that can take work: one offline with no Auto On plug would not.
    """
    refusal = placement_refusal(job, printer, exact_model=True)
    if refusal is None and not printer.available:
        return Refusal("offline")
    return refusal


def variant_for(job: ForecastJob, printer_model: str | None) -> ForecastVariant | None:
    """The alternative a printer of ``printer_model`` prints, the first in the scheduler's order."""
    key = _model_key(printer_model)
    return next((v for v in job.variants if _model_key(v.model) == key), None)


def duration_on(job: ForecastJob, printer_model: str | None) -> int:
    """How long ``job`` prints on a printer of ``printer_model``: its alternative's time, if any."""
    variant = variant_for(job, printer_model)
    return variant.duration_s if variant is not None and variant.duration_s else job.duration_s


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def earliest_start(job: ForecastJob) -> datetime | None:
    """The soonest ``job`` may start: its scheduled time, or someone there to start it by hand."""
    times = [t for t in (_aware(job.scheduled_time), _aware(job.manual_start_from)) if t is not None]
    return max(times) if times else None


def place_jobs(
    jobs: list[ForecastJob],
    printers: list[ForecastPrinter],
    now: datetime,
    ready_after: Callable[[datetime], datetime] | None = None,
) -> tuple[list[Placement], list[int]]:
    """Place ``jobs`` on ``printers`` the way the scheduler would take them.

    ``jobs`` come in dispatch order and ``printers`` in the order an "Any" job
    picks among free ones (Settings > Queue > printer order). Whichever printer
    is free first takes the first job that may run on it and whose scheduled
    time has come (or someone is there to start it by hand); ties go to the
    printer earlier in that order. A pinned job
    waits for its printer even when the printer is offline, so it stays on its
    lane; an "Any" job only counts printers that can take work, and one the
    timeline's plan reserved only its printer. One the product planner
    reserved (``reservation_soft``) may also go on any printer it fits, but
    only while its own is free more than ``yield_margin_s`` later than that
    one. ``ready_after`` says when a
    printer whose print ends at a given time can start the next one (someone
    has to clear the plate: services/staffed_hours.py); without it, at once.

    Returns the placements and the ids of "Any" jobs no printer can take.
    """
    rank = {p.id: i for i, p in enumerate(printers)}
    model_of = {p.id: p.model for p in printers}
    free_at = {p.id: max(_aware(p.free_at) or now, now) for p in printers}
    # Breaks ties after free_at: a printer that stepped aside for a soft hold's
    # own printer goes after it at the same moment.
    behind = dict.fromkeys(rank, 0)
    takers: dict[int, set[int]] = {}
    unplaced: list[int] = []
    soft: dict[int, int] = {}  # job id -> the printer its soft hold is for
    for job in jobs:
        reserved = job.reserved_printer_id if job.reserved_printer_id in rank else None
        if job.printer_id is not None:
            ids = {job.printer_id} if job.printer_id in rank else set()
        elif reserved is not None and not job.reservation_soft:
            ids = {reserved}
        else:
            ids = {p.id for p in printers if p.available and placement_refusal(job, p, exact_model=True) is None}
            if reserved is not None:
                ids.add(reserved)
                soft[job.id] = reserved
        if ids:
            takers[job.id] = ids
        elif job.printer_id is None:
            unplaced.append(job.id)

    waiting = [job for job in jobs if job.id in takers]
    open_printers = set().union(*takers.values()) if takers else set()
    placements: list[Placement] = []

    def deferred(job: ForecastJob, printer_id: int, t: datetime) -> bool:
        # A soft hold's job, on another printer than its own, while its own is
        # due within the margin.
        own = soft.get(job.id)
        return own is not None and own != printer_id and (free_at[own] - t).total_seconds() <= job.yield_margin_s

    while waiting and open_printers:
        printer_id = min(open_printers, key=lambda pid: (free_at[pid], behind[pid], rank[pid]))
        t = free_at[printer_id]
        fits = [job for job in waiting if printer_id in takers[job.id]]
        if not fits:
            open_printers.discard(printer_id)
            continue
        ready = next(
            (job for job in fits if (earliest_start(job) or t) <= t and not deferred(job, printer_id, t)), None
        )
        if ready is None:
            # Only jobs scheduled for later fit, or soft holds' jobs whose own
            # printer is due soon: the printer idles until the first comes, or
            # until that printer has had its turn (then it took the job, or is
            # further off).
            later = [s for job in fits if (s := earliest_start(job)) is not None and s > t]
            owners = [soft[job.id] for job in fits if (earliest_start(job) or t) <= t]
            wake = min([*later, *(free_at[own] for own in owners)])
            if owners and wake == min(free_at[own] for own in owners):
                behind[printer_id] = 1 + max(behind[own] for own in owners if free_at[own] == wake)
            free_at[printer_id] = wake
            continue
        # A job with alternatives prints the first whose model this printer is,
        # as the scheduler walks them, and takes that file's print time.
        end = t + timedelta(seconds=duration_on(ready, model_of[printer_id]))
        placements.append(
            Placement(
                ready.id,
                printer_id,
                t,
                end,
                projected=ready.printer_id is None,
                variant=variant_for(ready, model_of[printer_id]),
                reserved=ready.printer_id is None and ready.reserved_printer_id == printer_id,
            )
        )
        free_at[printer_id] = ready_after(end) if ready_after is not None else end
        behind[printer_id] = 0
        waiting.remove(ready)
    return placements, unplaced


@dataclass
class OffTimeline:
    """A pending job the forecast does not place, and why."""

    item_id: int
    # waiting | no_printer | unassigned | starting (manual_start, before such
    # jobs went on the lanes)
    reason: str
    detail: str | None = None


@dataclass
class PlateWait:
    """A printer standing with a finished print on its plate until someone clears it."""

    printer_id: int
    start: datetime
    end: datetime
    # Why until then (PlateTurnaround.explain), or ``waiting``/``away`` for a
    # plate waiting now: as usual, or for longer than usual.
    reason: str = "clear"


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
    # item id -> printer id -> why the job may not be pinned to that printer
    refusals: dict[int, dict[int, Refusal]]
    # Every pending job the forecast looked at, to filter by what the caller may read.
    items: dict[int, PrintQueueItem]
    # item id -> (printer id, whether it holds now) for the jobs the plan reserved
    reservations: dict[int, tuple[int, bool]] = field(default_factory=dict)
    # item id -> printer id -> why the plan may not hold the "Any" job for that printer
    reserve_refusals: dict[int, dict[int, Refusal]] = field(default_factory=dict)
    # item id -> its alternatives (#671), for the jobs that have them
    variants: dict[int, tuple[ForecastVariant, ...]] = field(default_factory=dict)
    # Printers standing with a finished plate, now and after each forecast print.
    plate_waits: list[PlateWait] = field(default_factory=list)
    # When someone is there to clear plates, and whether the scheduler waits for it.
    turnaround: PlateTurnaround | None = None
    # For the product planner only, never sent to the timeline: the placements
    # with the jobs held for filament on the lanes too (ForecastInputs.planning_jobs).
    planning_placements: list[Placement] = field(default_factory=list)


@dataclass
class ForecastInputs:
    """What the forecast is worked out from, read once (the plan apply reuses it)."""

    now: datetime
    sjf_enabled: bool
    # In the order an "Any" job picks among free printers.
    printers: list[ForecastPrinter]
    printer_states: list[PrinterForecast]
    # Pending jobs in dispatch order, and each one's forecast job.
    pending: list[PrintQueueItem]
    jobs: dict[int, ForecastJob]
    # The jobs that go on the lanes, in dispatch order, and the rest with why.
    schedulable: list[ForecastJob]
    off_timeline: list[OffTimeline]
    reservations: dict[int, tuple[int, bool]]
    turnaround: PlateTurnaround
    # Printers whose plate waits to be cleared before their first forecast job.
    plate_waits: list[PlateWait]
    # Jobs in ``off_timeline`` as "waiting" for filament someone has to load or
    # change (is_filament_hold_reason), in dispatch order.
    held: list[ForecastJob] = field(default_factory=list)

    @property
    def ready_after(self) -> Callable[[datetime], datetime] | None:
        return self.turnaround.as_function()

    def planning_jobs(self, swap_s: int) -> list[ForecastJob]:
        """The jobs to plan with: those on the lanes and those held for filament,
        in dispatch order. A held job starts no sooner than someone is there
        and has had ``swap_s`` to load its filament. Copies: the jobs here stay
        as they are."""
        loaded_by = self.turnaround.someone_there()[0] + timedelta(seconds=swap_s)
        held = {job.id for job in self.held}
        order = {item.id: index for index, item in enumerate(self.pending)}
        result = []
        for job in sorted([*self.schedulable, *self.held], key=lambda job: order.get(job.id, len(order))):
            if job.id in held:
                start = max(_aware(job.manual_start_from) or loaded_by, loaded_by)
                result.append(replace(job, manual_start_from=start))
            else:
                result.append(replace(job))
        return result


def _dispatch_order_key(sjf_enabled: bool):
    """The order of ``check_queue``'s query, as a sort key."""

    def key(item: PrintQueueItem):
        position = (item.position or 0, item.id)
        if not sjf_enabled:
            return position
        duration = item.print_time_seconds
        return (not item.been_jumped, duration is None, duration or 0, *position)

    return key


def is_filament_hold_reason(reason: str | None) -> bool:
    """Whether a waiting job is held for filament someone has to load or change.

    The matcher's missing type or colour and unfillable slot, and the
    unmatched-filament hold's "Needs ..." (a job staged for a manual start,
    which goes on the lanes anyway). A spool too light stages the job for a
    manual start too. Any other hold (nozzle, access, deleted files, a file
    sliced for another model, a sensor interlock, printer tags) is not one.
    """
    from backend.app.services.print_scheduler import _is_unmatched_hold_reason

    if not reason:
        return False
    return _is_unmatched_hold_reason(reason) or any(marker in reason for marker in _FILAMENT_WAIT_MARKERS)


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


def _forecast_variants(item: PrintQueueItem) -> tuple[ForecastVariant, ...]:
    """The item's alternatives in the scheduler's order (``_candidates_for``):
    files that still exist, least-attempted first, then the user's priority."""
    usable = [v for v in item.variants if v.library_file is not None and v.library_file.deleted_at is None]
    usable.sort(key=lambda v: (v.attempt_count or 0, v.position, v.id))
    result = []
    for v in usable:
        meta = v.library_file.file_metadata or {}
        result.append(
            ForecastVariant(
                library_file_id=v.library_file_id,
                model=v.target_model,
                duration_s=v.print_time_seconds,
                name=meta.get("print_name") or v.library_file.filename,
                plate_id=v.plate_id,
                has_thumbnail=bool(v.library_file.thumbnail_path),
            )
        )
    return tuple(result)


async def load_forecast_inputs(db: AsyncSession, now: datetime | None = None) -> ForecastInputs:
    """The printers' live state and the pending jobs, as the forecast sees them."""
    # Imported here: the scheduler module pulls in much of the app at import time.
    from backend.app.services.plate_clears import load_last_clear, load_learned, load_waiting_since
    from backend.app.services.print_scheduler import _order_printers, scheduler
    from backend.app.services.printer_manager import printer_manager
    from backend.app.services.printer_tags import TagRouting
    from backend.app.services.queue_reservations import QueueReservations
    from backend.app.services.staffed_hours import PlateTurnaround, read_staffed_hours

    now = now or datetime.now(timezone.utc)

    printers = list((await db.execute(select(Printer).order_by(Printer.id))).scalars().all())
    order = await scheduler._get_model_dispatch_order(db)
    last_finished = None
    if order == "least_recently_used" and printers:
        last_finished = await scheduler._last_finished_by_printer(db, [p.id for p in printers])
    printers = _order_printers(printers, order, last_finished)
    wakeable = await scheduler._wakeable_printer_ids(db)
    sjf_enabled = await scheduler._get_bool_setting(db, "queue_shortest_first")
    hours = await read_staffed_hours(db)
    waits_for_plate = await scheduler._get_bool_setting(db, "require_plate_clear", default=False)
    if waits_for_plate and hours.learn:
        learned, learned_samples = await load_learned(db, hours.zone(), now)
        awaiting_ids = [p.id for p in printers if printer_manager.is_awaiting_plate_clear(p.id)]
        turnaround = PlateTurnaround.build(
            hours,
            waits_for_plate,
            now,
            learned=learned,
            learned_samples=learned_samples,
            waiting_since=await load_waiting_since(db, awaiting_ids, now),
            last_clear=await load_last_clear(db),
        )
    else:
        turnaround = PlateTurnaround.build(hours, waits_for_plate, now)
    plate_waits: list[PlateWait] = []

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
    stored_reservations = await QueueReservations.load(db, pending, wakeable=wakeable)

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
        awaiting_plate = printer_manager.is_awaiting_plate_clear(printer.id)
        if running is not None or busy:
            # Its plate has to be cleared after the print.
            plate_from = free_at
            free_at, reason = turnaround.explain(plate_from)
            if free_at > plate_from:
                plate_waits.append(PlateWait(printer.id, plate_from, free_at, reason))
        elif awaiting_plate:
            # Standing with a finished plate now, since the print ended.
            plate_from, free_at, reason = turnaround.waiting_plate(printer.id)
            free_at = max(free_at, now)
            if free_at > plate_from:
                plate_waits.append(PlateWait(printer.id, plate_from, free_at, reason))
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
                awaiting_plate_clear=awaiting_plate,
            )
        )

    creator_scopes: dict[int | None, PrinterScope] = {}
    jobs: dict[int, ForecastJob] = {}
    reservations: dict[int, tuple[int, bool]] = {}
    schedulable: list[ForecastJob] = []
    off_timeline: list[OffTimeline] = []
    held: list[ForecastJob] = []
    manual_start_from = turnaround.someone_there()[0]
    for item in pending:
        variant_models = tuple(v.target_model for v in item.variants if v.target_model)
        variants = _forecast_variants(item)
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
            variants=variants,
            scheduled_time=item.scheduled_time,
            duration_s=item.print_time_seconds or DEFAULT_DURATION_S,
            blocked=blocked,
            allowed_printers=allowed,
        )
        jobs[item.id] = job
        reserved_for = stored_reservations.stored_printer(item)
        if reserved_for is not None:
            # Kept to only where the scheduler keeps to it (queue_reservations).
            printer = next((p for p in forecast_printers if p.id == reserved_for), None)
            holds = printer is not None and reservation_refusal(job, printer) is None
            reservations[item.id] = (reserved_for, holds)
            if holds:
                job.reserved_printer_id = reserved_for
                if stored_reservations.is_soft(item):
                    job.reservation_soft = True
                    job.yield_margin_s = stored_reservations.yield_margin_s(item)

        if item.manual_start:
            # Whatever else it waits for (filament to load, #1496/#2799), someone
            # has to be there to press Start.
            job.manual_start_from = manual_start_from
        if item.dispatching_at is not None and item.printer_id is None:
            off_timeline.append(OffTimeline(item.id, "starting"))
        elif item.manual_start:
            schedulable.append(job)
        elif item.waiting_reason and not _is_busy_only(item.waiting_reason) and not _waits_only_for_its_plate(item):
            off_timeline.append(OffTimeline(item.id, "waiting", item.waiting_reason))
            if is_filament_hold_reason(item.waiting_reason):
                held.append(job)
        elif item.printer_id is None and not item.target_model and not variant_models:
            off_timeline.append(OffTimeline(item.id, "unassigned"))
        else:
            schedulable.append(job)

    return ForecastInputs(
        now=now,
        sjf_enabled=sjf_enabled,
        printers=forecast_printers,
        printer_states=printer_states,
        pending=pending,
        jobs=jobs,
        schedulable=schedulable,
        off_timeline=off_timeline,
        reservations=reservations,
        turnaround=turnaround,
        plate_waits=plate_waits,
        held=held,
    )


async def build_queue_forecast(db: AsyncSession, now: datetime | None = None) -> QueueForecast:
    """Forecast the whole queue on every printer, from the database and live printer state."""
    inputs = await load_forecast_inputs(db, now)
    ready_after = inputs.ready_after
    placements, unplaced = place_jobs(inputs.schedulable, inputs.printers, inputs.now, ready_after)
    off_timeline = [*inputs.off_timeline, *(OffTimeline(item_id, "no_printer") for item_id in unplaced)]
    plate_waits = list(inputs.plate_waits)
    if ready_after is not None:
        for p in placements:
            ready, reason = inputs.turnaround.explain(p.end)
            if ready > p.end:
                plate_waits.append(PlateWait(p.printer_id, p.end, ready, reason))

    refusals: dict[int, dict[int, Refusal]] = {}
    reserve_refusals: dict[int, dict[int, Refusal]] = {}
    for item_id, job in inputs.jobs.items():
        per_printer = {
            printer.id: refusal
            for printer in inputs.printers
            if (refusal := placement_refusal(job, printer, exact_model=False)) is not None
        }
        if per_printer:
            refusals[item_id] = per_printer
        if job.printer_id is None:
            per_printer = {
                printer.id: refusal
                for printer in inputs.printers
                if (refusal := reservation_refusal(job, printer)) is not None
            }
            if per_printer:
                reserve_refusals[item_id] = per_printer

    return QueueForecast(
        generated_at=inputs.now,
        placements=placements,
        off_timeline=off_timeline,
        printers=inputs.printer_states,
        refusals=refusals,
        items={item.id: item for item in inputs.pending},
        reservations=inputs.reservations,
        reserve_refusals=reserve_refusals,
        variants={item_id: job.variants for item_id, job in inputs.jobs.items() if job.variants},
        plate_waits=plate_waits,
        turnaround=inputs.turnaround,
        planning_placements=place_jobs(inputs.planning_jobs(HELD_SWAP_S), inputs.printers, inputs.now, ready_after)[0],
    )
