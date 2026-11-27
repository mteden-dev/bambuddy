"""How long a product's plates really print, and how often they fail (fork).

The planner takes a plate's print time from the slicer and treats every plate
as equally safe. This learns both from the plate's own history: the jobs the
planner (or someone by hand) printed of it, ``custom_product_jobs``.

A run counts for a plate when it is a job of that plate that actually started
and ended in the last 90 days. A job cancelled while it waited, or one the
printer never started (the scheduler gave up), is no run at all.

- Duration: the median real print time of the last 10 successful runs, once
  there are 3. Only runs of the same slicing as now count: the slicer's
  estimate the run was planned with within 1% of the plate's current one, so
  a plate sliced again starts over. That estimate is the one the planner
  recorded with the job (``ProductJob.plan_info["estimate_s"]``): the queue
  job carries the learned time the plan used, not the slicer's. A job from
  before that key (or queued by hand) has its queue job's
  ``print_time_seconds``. A run that took
  under half or over twice its estimate is left out (paused overnight, a
  clock that jumped), and what is learned stays within 0.7x-1.5x of the
  current estimate.
- Risk: (failed + 0.5) / (runs + 25), at most 0.5. A print stopped after it
  started failed too: it made no pieces. With no history that is 2%, and it
  never reaches 0, as one plate printed fine a few times is no proof it
  always will.

Where it reads a run from:

- the queue job, while it is still there and is the job's (SQLite gives a
  freed id to the next job, so its ``created_at`` must be the job's
  ``item_created_at``): whether it started (``started_at``), how it ended
  (``status``), its estimate (when the job recorded none), and its times;
- the print log run of it (``print_log_entries``, by archive and queue job,
  or by archive, printer and end): the measured ``duration_seconds``, and
  whether a job whose queue job was deleted had started at all.

Odd data (no end, a deleted queue job or archive, a run that cannot be told
apart) skips that run; nothing here raises for it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob, ProductPlate

LOOKBACK = timedelta(days=90)
# The duration goes by the latest runs, once there are enough of them.
DURATION_RUNS = 10
MIN_DURATION_RUNS = 3
# The run's estimate this close to the current one: the same slicing.
SAME_SLICING = 0.01
# A run outside these times its estimate did not print straight through.
MIN_RATIO = 0.5
MAX_RATIO = 2.0
# What is learned stays within these times the current estimate.
MIN_LEARNED = 0.7
MAX_LEARNED = 1.5
# Risk smoothing: as if every plate had printed 25 times with half a failure.
PRIOR_FAILED = 0.5
PRIOR_RUNS = 25
MAX_RISK = 0.5
# A queue job created this close to the job's record is the job's own.
SAME_ITEM_S = 2
# A print log run ending this close to the job is its run (as products._job_run).
RUN_MATCH_S = 600

ENDED = ("done", "failed", "cancelled")
# Print log statuses of a print that started and did not finish.
LOG_STOPPED = ("failed", "stopped", "cancelled", "aborted")


@dataclass(frozen=True)
class PlateHistory:
    duration_s: int | None  # how long the plate really prints; None: not enough history, use the slicer's
    risk: float  # the chance a print of it fails, 0..1 (smoothed; never 0)
    runs: int  # finished runs the two were worked out from


@dataclass(frozen=True)
class Run:
    """One print of a plate that started and ended."""

    ended_at: datetime
    failed: bool
    # Measured print time; None when not known.
    real_s: int | None = None
    # The slicer's estimate it was planned with; None when not known.
    estimate_s: int | None = None


# ── The rules ────────────────────────────────────────────────────────────────


def same_slicing(run_estimate: int | None, estimate: int) -> bool:
    return run_estimate is not None and abs(run_estimate - estimate) <= SAME_SLICING * estimate


def learned_duration(runs: Iterable[Run], estimate: int | None) -> int | None:
    """The median real time of the latest successful runs of this slicing, or None for too few."""
    if not estimate or estimate <= 0:
        return None
    usable = [
        r
        for r in runs
        if not r.failed
        and r.real_s is not None
        and r.estimate_s is not None
        and same_slicing(r.estimate_s, estimate)
        and MIN_RATIO * r.estimate_s <= r.real_s <= MAX_RATIO * r.estimate_s
    ]
    usable.sort(key=lambda r: r.ended_at, reverse=True)
    latest = usable[:DURATION_RUNS]
    if len(latest) < MIN_DURATION_RUNS:
        return None
    learned = median(r.real_s for r in latest if r.real_s is not None)
    return round(min(max(learned, MIN_LEARNED * estimate), MAX_LEARNED * estimate))


def failure_risk(runs: int, failed: int) -> float:
    return min(MAX_RISK, (failed + PRIOR_FAILED) / (runs + PRIOR_RUNS))


def summarise(runs: list[Run], estimate: int | None) -> PlateHistory:
    return PlateHistory(
        duration_s=learned_duration(runs, estimate),
        risk=failure_risk(len(runs), sum(1 for r in runs if r.failed)),
        runs=len(runs),
    )


# ── Telling what a job was ───────────────────────────────────────────────────


@dataclass(frozen=True)
class ItemRow:
    """The job's own queue job (not one that took its id since)."""

    status: str | None
    started_at: datetime | None
    completed_at: datetime | None
    estimate_s: int | None


@dataclass(frozen=True)
class LogRow:
    """The print log run of the job."""

    status: str | None
    duration_s: int | None
    unmeasured: bool = False


def job_run(
    job_status: str,
    finished_at: datetime | None,
    item: ItemRow | None,
    log: LogRow | None,
    estimate_s: int | None = None,
) -> Run | None:
    """The run a finished job was, or None when it never started or cannot be told.

    ``estimate_s`` is the slicer's estimate recorded with the job; without it
    the queue job's is taken.
    """
    if finished_at is None or job_status not in ENDED:
        return None
    if item is not None:
        if job_status == "done":
            failed = False
        elif item.started_at is None:
            # Cancelled while it waited, or a start the printer never took.
            return None
        elif job_status == "failed" or item.status == "cancelled":
            failed = True
        else:
            # Skipped: it never printed.
            return None
    elif job_status == "done":
        failed = False
    elif log is not None and log.status in LOG_STOPPED:
        # Its queue job is gone; the print log says it started.
        failed = True
    else:
        return None
    return Run(
        ended_at=_naive(finished_at),
        failed=failed,
        real_s=None if failed else _real_time(item, log),
        estimate_s=estimate_s if estimate_s is not None else (item.estimate_s if item is not None else None),
    )


def recorded_estimate(plan_info: Mapping | None) -> int | None:
    """The slicer's estimate the planner recorded with a job (``plan_info["estimate_s"]``)."""
    value = plan_info.get("estimate_s") if isinstance(plan_info, Mapping) else None
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else None


def _real_time(item: ItemRow | None, log: LogRow | None) -> int | None:
    # The print log's measured time first: the queue job's times also hold the upload.
    if log is not None and log.status == "completed" and not log.unmeasured and log.duration_s and log.duration_s > 0:
        return log.duration_s
    if item is not None and item.status == "completed" and item.started_at and item.completed_at:
        seconds = int((_naive(item.completed_at) - _naive(item.started_at)).total_seconds())
        return seconds if seconds > 0 else None
    return None


def _naive(value: datetime) -> datetime:
    """UTC without a zone, as the database keeps it."""
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


# ── Loading ──────────────────────────────────────────────────────────────────


async def load_plate_history(
    db: AsyncSession,
    plates: Iterable[ProductPlate],
    estimates: Mapping[int, int],
    now: datetime | None = None,
) -> dict[int, PlateHistory]:
    """What each plate's history says: every plate asked for gets an entry.

    ``estimates`` is plate id -> the slicer's current estimate in seconds.
    Two queries for all the plates: the jobs with their queue jobs, and the
    print log runs of their archives.
    """
    plate_ids = sorted({p.id for p in plates})
    if not plate_ids:
        return {}
    since = _naive(now or datetime.now(timezone.utc)) - LOOKBACK

    rows = (
        await db.execute(
            select(
                ProductJob.product_plate_id,
                ProductJob.status,
                ProductJob.finished_at,
                ProductJob.item_created_at,
                ProductJob.archive_id,
                ProductJob.printer_id,
                ProductJob.plan_info,
                PrintQueueItem.id,
                PrintQueueItem.created_at,
                PrintQueueItem.status,
                PrintQueueItem.started_at,
                PrintQueueItem.completed_at,
                PrintQueueItem.print_time_seconds,
                PrintQueueItem.archive_id,
            )
            .outerjoin(PrintQueueItem, PrintQueueItem.id == ProductJob.queue_item_id)
            .where(
                ProductJob.product_plate_id.in_(plate_ids),
                ProductJob.status.in_(ENDED),
                ProductJob.finished_at >= since,
            )
        )
    ).all()

    jobs = []
    for (
        plate_id,
        status,
        finished_at,
        item_created_at,
        job_archive,
        printer_id,
        plan_info,
        item_id,
        created_at,
        item_status,
        started_at,
        completed_at,
        item_estimate,
        item_archive,
    ) in rows:
        item = None
        if item_id is not None and _same_item(item_created_at, created_at):
            item = ItemRow(item_status, started_at, completed_at, item_estimate)
        else:
            item_id = None
        archive_id = job_archive or (item_archive if item is not None else None)
        jobs.append(
            (
                plate_id,
                status,
                finished_at,
                item,
                item_id,
                created_at,
                archive_id,
                printer_id,
                recorded_estimate(plan_info),
            )
        )

    logs_by_archive: dict[int, list] = {}
    archive_ids = sorted({j[6] for j in jobs if j[6] is not None})
    if archive_ids:
        for log in (
            await db.execute(
                select(
                    PrintLogEntry.id,
                    PrintLogEntry.archive_id,
                    PrintLogEntry.queue_item_id,
                    PrintLogEntry.printer_id,
                    PrintLogEntry.status,
                    PrintLogEntry.started_at,
                    PrintLogEntry.completed_at,
                    PrintLogEntry.duration_seconds,
                    PrintLogEntry.duration_unmeasured,
                ).where(PrintLogEntry.archive_id.in_(archive_ids))
            )
        ).all():
            logs_by_archive.setdefault(log.archive_id, []).append(log)

    runs: dict[int, list[Run]] = {pid: [] for pid in plate_ids}
    for plate_id, status, finished_at, item, item_id, created_at, archive_id, printer_id, estimate in jobs:
        log = _find_log(logs_by_archive.get(archive_id, []), item_id, created_at, printer_id, finished_at)
        run = job_run(status, finished_at, item, log, estimate)
        if run is not None:
            runs[plate_id].append(run)

    return {pid: summarise(runs[pid], estimates.get(pid)) for pid in plate_ids}


def _same_item(item_created_at: datetime | None, created_at: datetime | None) -> bool:
    # As products._same_item: without both times there is nothing to tell them apart by.
    if item_created_at is None or created_at is None:
        return True
    return abs((_naive(created_at) - _naive(item_created_at)).total_seconds()) < SAME_ITEM_S


def _find_log(candidates, item_id, item_created_at, printer_id, finished_at) -> LogRow | None:
    """The job's print log run among its archive's runs, when it can be told apart."""
    if item_id is not None:
        # Not a run of an earlier job that had the same queue id and file.
        own = [
            c
            for c in candidates
            if c.queue_item_id == item_id
            and (
                item_created_at is None
                or c.started_at is None
                or _naive(c.started_at) >= _naive(item_created_at) - timedelta(seconds=SAME_ITEM_S)
            )
        ]
        if own:
            best = max(own, key=lambda c: c.id)
            return LogRow(best.status, best.duration_seconds, bool(best.duration_unmeasured))
    if printer_id is None or finished_at is None:
        return None
    end = _naive(finished_at)
    near = [
        c
        for c in candidates
        if c.printer_id == printer_id
        and c.completed_at is not None
        and abs((_naive(c.completed_at) - end).total_seconds()) <= RUN_MATCH_S
    ]
    if len(near) != 1:
        return None
    return LogRow(near[0].status, near[0].duration_seconds, bool(near[0].duration_unmeasured))
