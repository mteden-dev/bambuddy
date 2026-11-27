"""Apply the queue timeline's plan (fork).

In plan mode the user lays the queued jobs out on the printers' lanes: each lane
is the order a printer is to print them in. Applying the plan does two things:

- every "Any <model>" job the user moved is reserved for the printer it was
  put on (services/queue_reservations.py), so it waits for that printer;
- the one queue order is rewritten so the scheduler takes the jobs as laid out.
  The scheduler gives each free printer the first job in that order that may
  run on it, so the jobs are ordered by when the plan starts them;
- that alone does not keep a job the user left alone where the plan shows it
  when the plan changed when the printers free up: a printer whose lane now
  ends sooner takes the next job, wherever the plan put it. Replaying the plan
  finds those jobs, and they are reserved for their lane's printer too.

Replayed from the printers' live state, the forecast then puts every job back
where the plan has it, as long as prints take as long as their files say.

Jobs the plan does not lay out (held for a manual start, missing filament…)
keep their places in the order.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import queue_reservations
from backend.app.services.queue_forecast import (
    ForecastJob,
    ForecastPrinter,
    _aware,
    build_queue_forecast,
    duration_on,
    earliest_start,
    load_forecast_inputs,
    place_jobs,
    reservation_refusal,
)


class PlanError(Exception):
    """The plan cannot be applied as sent; ``status`` is the HTTP status to answer."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class PlanResult:
    # Reserved now, for the printer the plan put them on.
    reserved: list[int]
    # On a lane of the plan but forecast on another printer (or none) once applied.
    moved_elsewhere: list[int]


def planned_order(
    lanes: list[tuple[ForecastPrinter, list]],
    rank: dict[int, int],
    now: datetime,
    ready_after: Callable[[datetime], datetime] | None = None,
) -> list[int]:
    """The ids of the laid-out jobs in the order the plan starts them.

    ``lanes`` pairs each printer with its forecast jobs, in the plan's order. A
    lane starts when its printer is free and runs its jobs back to back, a job
    scheduled for later, or waiting for someone to start it by hand, waiting
    for its time, and each waiting for the plate before it to be cleared
    (``ready_after``). Equal starts go in the order an
    "Any" job picks among free printers, as the forecast breaks them.
    """
    starts: list[tuple[datetime, int, int, int]] = []
    for printer, jobs in lanes:
        t = max(_aware(printer.free_at) or now, now)
        for index, job in enumerate(jobs):
            scheduled = earliest_start(job)
            if scheduled is not None and scheduled > t:
                t = scheduled
            starts.append((t, rank[printer.id], index, job.id))
            t += timedelta(seconds=duration_on(job, printer.model))
            if ready_after is not None:
                t = ready_after(t)
    return [job_id for *_, job_id in sorted(starts)]


def _hold(job: ForecastJob, printer_id: int) -> None:
    job.reserved_printer_id = printer_id
    job.reservation_soft = False


async def apply_plan(
    db: AsyncSession,
    lanes: list[tuple[int, list[int]]],
    reserve: set[int],
    *,
    visible_printer: Callable[[int], bool] | None = None,
    now: datetime | None = None,
) -> PlanResult:
    """Reserve the moved jobs and rewrite the queue order to follow ``lanes``.

    ``lanes`` are (printer id, job ids in order); ``reserve`` the "Any" jobs to
    hold for the printer whose lane they are on. A job that started or left the
    queue since the plan was drawn is passed over.
    """
    inputs = await load_forecast_inputs(db, now)
    if inputs.sjf_enabled:
        raise PlanError(409, "Shortest job first sets the queue order, so it cannot be planned")

    printers = {p.id: p for p in inputs.printers}
    rank = {p.id: i for i, p in enumerate(inputs.printers)}
    seen: set[int] = set()
    laid_out: list[tuple[ForecastPrinter, list]] = []
    on_lane: dict[int, int] = {}
    for printer_id, item_ids in lanes:
        printer = printers.get(printer_id)
        if printer is None or (visible_printer is not None and not visible_printer(printer_id)):
            raise PlanError(404, f"Printer {printer_id} not found")
        jobs = []
        for item_id in item_ids:
            if item_id in seen:
                raise PlanError(400, f"Job {item_id} is on more than one lane")
            seen.add(item_id)
            job = inputs.jobs.get(item_id)
            if job is None:
                continue  # started or removed since the plan was drawn
            if job.printer_id is not None and job.printer_id != printer_id:
                raise PlanError(400, f"Job {item_id} is pinned to another printer")
            jobs.append(job)
            on_lane[item_id] = printer_id
        laid_out.append((printer, jobs))

    to_reserve = []
    for item_id in sorted(reserve):
        job = inputs.jobs.get(item_id)
        if job is None or job.printer_id is not None:
            continue  # gone, or pinned: it is held there already
        if item_id not in on_lane:
            raise PlanError(400, f"Job {item_id} is reserved but on no lane")
        refusal = reservation_refusal(job, printers[on_lane[item_id]])
        if refusal is not None:
            raise PlanError(
                400,
                f"Job {item_id} cannot be held for printer {on_lane[item_id]}: {refusal.code}"
                + (f" ({refusal.detail})" if refusal.detail else ""),
            )
        to_reserve.append(item_id)

    # The moved jobs wait for their printers in the replay too, firmly: the
    # user's hold replaces any the product planner left.
    for item_id in to_reserve:
        _hold(inputs.jobs[item_id], on_lane[item_id])

    planned = iter(planned_order(laid_out, rank, inputs.now, inputs.ready_after))
    planned_ids = set(on_lane)
    items = inputs.pending
    order = [next(planned) if item.id in planned_ids else item.id for item in items]
    position = {item_id: index + 1 for index, item_id in enumerate(order)}
    for item in items:
        item.position = position[item.id]

    # Hold, one at a time and first in the order first (holding one can put
    # the next back), each job the replay would hand another printer.
    schedulable = sorted(inputs.schedulable, key=lambda job: position[job.id])
    on_timeline = {job.id for job in schedulable}
    for _ in range(len(on_lane)):
        placed = {
            p.item_id: p.printer_id for p in place_jobs(schedulable, inputs.printers, inputs.now, inputs.ready_after)[0]
        }
        jumped = [
            item_id
            for item_id, printer_id in on_lane.items()
            if item_id in on_timeline
            and item_id not in to_reserve
            and placed.get(item_id) != printer_id
            and inputs.jobs[item_id].printer_id is None
            and reservation_refusal(inputs.jobs[item_id], printers[printer_id]) is None
        ]
        if not jumped:
            break
        first = min(jumped, key=position.__getitem__)
        _hold(inputs.jobs[first], on_lane[first])
        to_reserve.append(first)

    by_id = {item.id: item for item in items}
    for item_id in to_reserve:
        await queue_reservations.reserve(db, by_id[item_id], on_lane[item_id])
    await queue_reservations.release_finished(db)
    await db.commit()

    forecast = await build_queue_forecast(db, now)
    placed = {p.item_id: p.printer_id for p in forecast.placements}
    moved_elsewhere = [item_id for item_id, printer_id in on_lane.items() if placed.get(item_id) != printer_id]
    return PlanResult(reserved=to_reserve, moved_elsewhere=moved_elsewhere)
