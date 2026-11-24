"""How long finished plates wait for someone to clear them (fork).

With plate-clear confirmation on, a printer stands after each print until
someone clears the plate. Staffed hours (services/staffed_hours.py) say when
people are meant to be around, but at a farm nobody marks a lunch break or a
trip to the shop. This learns, from what actually happened, how long a plate
finished at a given hour of the week usually waits, and reads what is going on
now: a plate waiting far longer than usual means nobody is there, a plate
cleared a moment ago means somebody is.

What it learns from:

- every plate-clear gate edge, recorded from ``printer_manager`` into
  ``custom_plate_clears``: when the print ended, when the plate was cleared,
  whether a queued job was waiting, and whether a person cleared it
  (plate-clear confirmation on) or the queue did on its own;
- before that table has rows, the print history: the time from a print's end
  to the start of the next queued job on that printer, when that job was
  already waiting as the print ended. Gaps under two minutes are the queue
  starting the next job itself (plate-clear confirmation was off then), and
  gaps over four days a printer that stood for another reason.
"""

from __future__ import annotations

import bisect
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.plate_clears import PlateClear
from backend.app.models.print_queue import PrintQueueItem

logger = logging.getLogger(__name__)

# How far back the forecast learns from, and how long rows are kept.
LOOKBACK = timedelta(days=56)
KEEP = timedelta(days=120)
# A longer wait is not someone being away (a long weekend fits); the printer stood for another reason.
MAX_WAIT = timedelta(days=4)
# A shorter gap in the print history is the queue starting the next job itself.
MIN_HISTORY_WAIT = timedelta(minutes=2)
# How many plates the forecast wants to have seen before it goes by them, in
# all and around a given hour.
MIN_SAMPLES = 10
MIN_NEARBY = 6
# Few enough longer waits and the remaining wait of a waiting plate is not worked out from them.
MIN_LONGER = 3
WEEK_SLOTS = 7 * 24


def _naive(value: datetime) -> datetime:
    """UTC without a zone, as the database keeps it."""
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# ── Recording ────────────────────────────────────────────────────────────────


async def record_gate_change(printer_id: int, awaiting: bool, at: datetime) -> None:
    """Note a plate-clear gate edge: a print ended (``awaiting``) or its plate was cleared.

    Scheduled by ``printer_manager.set_awaiting_plate_clear`` on every change.
    Never raises: the forecast does without a row it missed.
    """
    from backend.app.core.database import run_with_retry

    async def _do(db: AsyncSession) -> None:
        await record_gate_change_in(db, printer_id, awaiting, at)
        await db.commit()

    try:
        await run_with_retry(_do, label=f"plate clear printer={printer_id}")
    except Exception as e:
        logger.warning("Failed to record plate-clear edge for printer %d: %s", printer_id, e)


async def record_gate_change_in(db: AsyncSession, printer_id: int, awaiting: bool, at: datetime) -> None:
    """``record_gate_change`` in the caller's session. The caller commits."""
    from backend.app.api.routes.settings import get_setting, setting_is_true

    at = _naive(at)
    if awaiting:
        # A gate that went up again without coming down: that plate's clearing was missed.
        await db.execute(delete(PlateClear).where(PlateClear.printer_id == printer_id, PlateClear.cleared_at.is_(None)))
        pending = (
            await db.execute(select(func.count()).select_from(PrintQueueItem).where(PrintQueueItem.status == "pending"))
        ).scalar() or 0
        db.add(PlateClear(printer_id=printer_id, finished_at=at, queue_waiting=pending > 0))
        await db.execute(delete(PlateClear).where(PlateClear.finished_at < at - KEEP))
        return

    row = (
        await db.execute(
            select(PlateClear)
            .where(PlateClear.printer_id == printer_id, PlateClear.cleared_at.is_(None))
            .order_by(PlateClear.finished_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        # The gate went up before anything was recorded: the print's end from the history.
        finished = (
            await db.execute(
                select(func.max(PrintArchive.completed_at)).where(
                    PrintArchive.printer_id == printer_id, PrintArchive.completed_at <= at
                )
            )
        ).scalar()
        if finished is None or at - _naive(finished) > MAX_WAIT:
            return
        row = PlateClear(printer_id=printer_id, finished_at=_naive(finished))
        db.add(row)
    row.cleared_at = at
    row.gated = setting_is_true(await get_setting(db, "require_plate_clear"))


# ── What happened ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Sample:
    """A plate finished at ``finished_at`` (UTC) that waited ``wait_s`` to be cleared."""

    finished_at: datetime
    wait_s: float


async def load_samples(db: AsyncSession, now: datetime) -> list[Sample]:
    """The plates of the last eight weeks that held up a queued job, and how long."""
    since = _naive(now - LOOKBACK)
    tracking_from = (await db.execute(select(func.min(PlateClear.finished_at)))).scalar()
    samples = [
        Sample(_aware(finished), (cleared - finished).total_seconds())
        for finished, cleared in (
            await db.execute(
                select(PlateClear.finished_at, PlateClear.cleared_at).where(
                    PlateClear.finished_at >= since,
                    PlateClear.cleared_at.is_not(None),
                    PlateClear.gated.is_(True),
                    PlateClear.queue_waiting.is_(True),
                )
            )
        ).all()
        if timedelta(0) <= cleared - finished <= MAX_WAIT
    ]
    samples.extend(await _history_samples(db, since, _naive(tracking_from) if tracking_from else None))
    return samples


async def _history_samples(db: AsyncSession, since: datetime, until: datetime | None) -> list[Sample]:
    """From before anything was recorded: a print's end to the next queued job already waiting for it."""
    if until is not None and until <= since:
        return []
    item_query = select(
        PrintQueueItem.printer_id, PrintQueueItem.created_at, PrintQueueItem.started_at, PrintQueueItem.scheduled_time
    ).where(
        PrintQueueItem.printer_id.is_not(None),
        PrintQueueItem.started_at.is_not(None),
        PrintQueueItem.started_at >= since,
    )
    # Prints with no recorded end count too: one started in between means the
    # queued job was not the next print.
    archive_query = select(PrintArchive.printer_id, PrintArchive.started_at, PrintArchive.completed_at).where(
        PrintArchive.printer_id.is_not(None),
        or_(PrintArchive.completed_at >= since - MAX_WAIT, PrintArchive.started_at >= since - MAX_WAIT),
    )
    if until is not None:
        item_query = item_query.where(PrintQueueItem.started_at <= until + MAX_WAIT)
        archive_query = archive_query.where(
            or_(PrintArchive.completed_at <= until + MAX_WAIT, PrintArchive.started_at <= until + MAX_WAIT)
        )

    ends: dict[int, list[datetime]] = {}
    starts: dict[int, list[datetime]] = {}
    for printer_id, started, completed in (await db.execute(archive_query)).all():
        if completed is not None:
            ends.setdefault(printer_id, []).append(_naive(completed))
        if started is not None:
            starts.setdefault(printer_id, []).append(_naive(started))
    for values in (*ends.values(), *starts.values()):
        values.sort()

    samples: list[Sample] = []
    for printer_id, created, started, scheduled in (await db.execute(item_query)).all():
        started = _naive(started)
        printer_ends = ends.get(printer_id, [])
        i = bisect.bisect_left(printer_ends, started) - 1
        if i < 0:
            continue
        print_end = printer_ends[i]
        if print_end < since or (until is not None and print_end >= until):
            continue
        # The queued job has to be the first print after that one, already waiting as it ended.
        printer_starts = starts.get(printer_id, [])
        j = bisect.bisect_right(printer_starts, print_end)
        if j < len(printer_starts) and printer_starts[j] < started - MIN_HISTORY_WAIT:
            continue
        if created is None or _naive(created) >= print_end:
            continue
        if scheduled is not None and _naive(scheduled) > print_end:
            continue
        wait = started - print_end
        if MIN_HISTORY_WAIT <= wait <= MAX_WAIT:
            samples.append(Sample(_aware(print_end), wait.total_seconds()))
    return samples


# ── What it learned ──────────────────────────────────────────────────────────


def week_slot(t: datetime, zone: ZoneInfo) -> int:
    """The hour of the week ``t`` falls in, in ``zone``: Monday 00:00-01:00 is 0."""
    local = _aware(t).astimezone(zone)
    return local.weekday() * 24 + local.hour


def _percentile(sorted_values: list[float], q: float) -> float:
    index = min(len(sorted_values) - 1, max(0, round(q * (len(sorted_values) - 1))))
    return sorted_values[index]


@dataclass
class LearnedTurnaround:
    """How long a plate finished at a given hour of the week usually waits."""

    zone: ZoneInfo
    samples: int
    # Per hour of the week (Monday 00:00 first, in the farm's zone): the waits
    # of plates finished around then, sorted, in seconds.
    nearby: list[list[float]]
    # Per hour of the week: the usual wait, in whole minutes.
    typical_minutes: list[int]
    # Per hour of the week: a wait longer than three in four of those, in seconds.
    long_s: list[float]
    every_wait: list[float]

    @classmethod
    def build(cls, samples: list[Sample], zone: ZoneInfo) -> LearnedTurnaround | None:
        if len(samples) < MIN_SAMPLES:
            return None
        week: list[list[float]] = [[] for _ in range(WEEK_SLOTS)]
        day: list[list[float]] = [[] for _ in range(24)]
        for sample in samples:
            slot = week_slot(sample.finished_at, zone)
            week[slot].append(sample.wait_s)
            day[slot % 24].append(sample.wait_s)
        every_wait = sorted(s.wait_s for s in samples)

        def around(buckets: list[list[float]], centre: int, spread: int) -> list[float]:
            return [w for d in range(-spread, spread + 1) for w in buckets[(centre + d) % len(buckets)]]

        nearby: list[list[float]] = []
        for slot in range(WEEK_SLOTS):
            # The same weekday around that hour; failing enough of those, any day.
            for buckets, centre, spread in ((week, slot, 1), (week, slot, 3), (day, slot % 24, 1), (day, slot % 24, 3)):
                waits = around(buckets, centre, spread)
                if len(waits) >= MIN_NEARBY:
                    break
            else:
                waits = every_wait
            nearby.append(sorted(waits))
        return cls(
            zone=zone,
            samples=len(samples),
            nearby=nearby,
            typical_minutes=[round(median(w) / 60) for w in nearby],
            long_s=[_percentile(w, 0.75) for w in nearby],
            every_wait=every_wait,
        )

    def typical(self, finished: datetime) -> timedelta:
        return timedelta(minutes=self.typical_minutes[week_slot(finished, self.zone)])

    def long_after(self, finished: datetime) -> timedelta:
        """A plate finished then has waited longer than usual after this."""
        return timedelta(seconds=self.long_s[week_slot(finished, self.zone)])

    def remaining(self, finished: datetime, waited: timedelta) -> timedelta | None:
        """How much longer a plate finished at ``finished`` that has waited ``waited`` is likely to wait.

        The usual rest of the waits that went on at least that long: from
        plates finished around the same hour, or failing enough of those, from
        any. None when hardly any plate waited that long.
        """
        waited_s = waited.total_seconds()
        for waits in (self.nearby[week_slot(finished, self.zone)], self.every_wait):
            longer = [w - waited_s for w in waits if w > waited_s]
            if len(longer) >= MIN_LONGER:
                return timedelta(seconds=median(longer))
        return None


async def load_learned(db: AsyncSession, zone: ZoneInfo, now: datetime) -> tuple[LearnedTurnaround | None, int]:
    """What the forecast learned, and from how many plates (also when too few to go by)."""
    samples = await load_samples(db, now)
    return LearnedTurnaround.build(samples, zone), len(samples)


# ── What is going on now ─────────────────────────────────────────────────────


async def load_waiting_since(db: AsyncSession, printer_ids: list[int], now: datetime) -> dict[int, datetime]:
    """When each of these printers' waiting plate was finished (UTC)."""
    if not printer_ids:
        return {}
    since: dict[int, datetime] = {
        printer_id: _aware(finished)
        for printer_id, finished in (
            await db.execute(
                select(PlateClear.printer_id, func.max(PlateClear.finished_at))
                .where(PlateClear.printer_id.in_(printer_ids), PlateClear.cleared_at.is_(None))
                .group_by(PlateClear.printer_id)
            )
        ).all()
    }
    missing = [pid for pid in printer_ids if pid not in since]
    if missing:
        # The gate went up before anything was recorded: the print's end from the history.
        for printer_id, finished in (
            await db.execute(
                select(PrintArchive.printer_id, func.max(PrintArchive.completed_at))
                .where(PrintArchive.printer_id.in_(missing), PrintArchive.completed_at.is_not(None))
                .group_by(PrintArchive.printer_id)
            )
        ).all():
            if finished is not None:
                since[printer_id] = _aware(finished)
    return {pid: min(since.get(pid, now), now) for pid in printer_ids}


async def load_last_clear(db: AsyncSession) -> datetime | None:
    """When a person last cleared a plate (UTC)."""
    last = (await db.execute(select(func.max(PlateClear.cleared_at)).where(PlateClear.gated.is_(True)))).scalar()
    return _aware(last) if last is not None else None
