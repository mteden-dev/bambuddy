"""When someone is at the farm to clear a finished plate (fork).

With plate-clear confirmation on (Settings > Queue), a printer that finished a
print waits until someone clears the plate and says so before the scheduler
starts its next job. The queue forecast assumed that happens the moment the
print ends, so a print finishing at 3 a.m. was followed by the next one at
3 a.m. on the timeline, while in fact the printer stands until morning.

The staffed hours say when people are around, per day of the week, in the
farm's time zone, and how long clearing a plate takes. The forecast then has
a printer start its next job once the first staffed moment after its print
has come and the plate has been cleared. The scheduler itself is unchanged:
it already waits for the confirmation.

Hours at a farm are not that regular, and nobody marks a break. With
``learn`` on (the default) the forecast also goes by what it learned
(services/plate_clears.py): how long a plate finished at that hour of the
week usually waits, and what is going on now. A plate waiting far longer than
usual means nobody is there, so every plate waits until whoever comes next;
a plate cleared a moment ago means somebody is, so a print ending soon is
cleared at once.

Stored as one settings row, which the official image ignores.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.db_dialect import upsert_setting
from backend.app.models.settings import Settings

if TYPE_CHECKING:
    from backend.app.services.plate_clears import LearnedTurnaround

logger = logging.getLogger(__name__)

SETTINGS_KEY = "queue_staffed_hours"
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
# How far ahead the staffed windows are worked out (the forecast rarely goes further).
HORIZON = timedelta(days=14)
MAX_CLEAR_MINUTES = 240
# A plate waiting less than this says nothing about whether anyone is there.
LONG_WAIT_MIN = timedelta(minutes=30)
# Someone who just cleared a plate is taken to be there this long after.
PRESENT_FOR = timedelta(minutes=30)
# Having learned nothing, a plate waiting long is expected to wait as long again, up to this.
GUESS_MAX = timedelta(hours=8)


@dataclass(frozen=True)
class DayHours:
    """One day's staffed hours, "HH:MM". An end at or before the start runs past midnight."""

    start: str
    end: str


@dataclass
class StaffedHours:
    enabled: bool = False
    # IANA name, e.g. "Europe/Warsaw": the hours are wall-clock times there.
    timezone: str = "UTC"
    # Monday first; None is a day nobody is there.
    days: list[DayHours | None] = field(default_factory=lambda: [DayHours("07:00", "22:00")] * 7)
    # How long clearing a plate takes once someone is there.
    clear_minutes: int = 0
    # Also go by how long plates actually wait, and by what is going on now.
    learn: bool = True

    def zone(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            return ZoneInfo("UTC")

    def windows(self, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
        """The staffed stretches overlapping ``start``..``end``, in UTC, in order."""
        if not self.enabled:
            return []
        zone = self.zone()
        found: list[tuple[datetime, datetime]] = []
        day = start.astimezone(zone).date() - timedelta(days=1)
        last = end.astimezone(zone).date()
        while day <= last:
            hours = self.days[day.weekday()]
            if hours is not None:
                opens = _at(day, hours.start, zone)
                closes = _at(day, hours.end, zone)
                if closes <= opens:
                    closes = _at(day + timedelta(days=1), hours.end, zone)
                if closes > start and opens < end:
                    found.append((opens, closes))
            day += timedelta(days=1)
        return found

    def to_json(self) -> dict:
        return {
            "enabled": self.enabled,
            "timezone": self.timezone,
            "days": [None if d is None else {"start": d.start, "end": d.end} for d in self.days],
            "clear_minutes": self.clear_minutes,
            "learn": self.learn,
        }


def _at(day, hhmm: str, zone: ZoneInfo) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone).astimezone(timezone.utc)


def parse(raw: str | dict | None) -> StaffedHours:
    """Read stored or sent hours; anything malformed falls back to the default."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except ValueError:
        return StaffedHours()
    if not isinstance(data, dict):
        return StaffedHours()
    days: list[DayHours | None] = []
    for entry in (data.get("days") or [])[:7]:
        if isinstance(entry, dict) and _TIME.match(str(entry.get("start"))) and _TIME.match(str(entry.get("end"))):
            if entry["start"] == entry["end"]:
                days.append(DayHours("00:00", "00:00"))  # around the clock
            else:
                days.append(DayHours(entry["start"], entry["end"]))
        else:
            days.append(None)
    if len(days) != 7:
        days = StaffedHours().days
    try:
        clear = int(data.get("clear_minutes") or 0)
    except (TypeError, ValueError):
        clear = 0
    tz_name = str(data.get("timezone") or "UTC")
    try:
        ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        tz_name = "UTC"
    return StaffedHours(
        enabled=bool(data.get("enabled")),
        timezone=tz_name,
        days=days,
        clear_minutes=max(0, min(MAX_CLEAR_MINUTES, clear)),
        learn=bool(data.get("learn", True)),
    )


async def read_staffed_hours(db: AsyncSession) -> StaffedHours:
    raw = (await db.execute(select(Settings.value).where(Settings.key == SETTINGS_KEY))).scalar()
    return parse(raw)


async def write_staffed_hours(db: AsyncSession, hours: StaffedHours) -> None:
    """Store the hours. The caller commits."""
    await upsert_setting(db, Settings, SETTINGS_KEY, json.dumps(hours.to_json(), separators=(",", ":")))


@dataclass
class PlateTurnaround:
    """When a printer that finished a print can start the next one."""

    hours: StaffedHours
    windows: list[tuple[datetime, datetime]]
    # With plate-clear confirmation off the scheduler does not wait at all.
    waits_for_plate: bool
    now: datetime | None = None
    learned: LearnedTurnaround | None = None
    # Plates learned from, also when too few to go by.
    learned_samples: int = 0
    # Nobody seems to be there until then: every plate waits for it.
    away_until: datetime | None = None
    # Someone cleared a plate a moment ago: a print ending before then is cleared at once.
    present_until: datetime | None = None
    # printer id -> (when its plate was finished, when it is expected to be
    # cleared, why) for the printers standing with a finished plate now.
    waiting: dict[int, tuple[datetime, datetime, str]] = field(default_factory=dict)

    @classmethod
    def build(
        cls,
        hours: StaffedHours,
        waits_for_plate: bool,
        now: datetime,
        *,
        learned: LearnedTurnaround | None = None,
        learned_samples: int = 0,
        waiting_since: dict[int, datetime] | None = None,
        last_clear: datetime | None = None,
    ) -> PlateTurnaround:
        turnaround = cls(
            hours,
            hours.windows(now - timedelta(days=1), now + HORIZON),
            waits_for_plate,
            now,
            learned if hours.learn else None,
            learned_samples,
        )
        if waits_for_plate and hours.learn:
            turnaround._read_the_room(waiting_since or {}, last_clear)
        return turnaround

    def _clear(self) -> timedelta:
        return timedelta(minutes=self.hours.clear_minutes)

    def next_staffed(self, t: datetime) -> datetime:
        """The first moment at or after ``t`` someone is there (``t`` without staffed hours)."""
        if not self.hours.enabled or not self.windows:
            return t
        for opens, closes in self.windows:
            if closes > t:
                return max(t, opens)
        return t  # past the horizon: no telling

    def _read_the_room(self, waiting_since: dict[int, datetime], last_clear: datetime | None) -> None:
        """Work out from the plates waiting now and the last one cleared who is there."""
        now = self.now
        assert now is not None
        clear = self._clear()
        if last_clear is not None and last_clear + PRESENT_FOR > now:
            self.present_until = last_clear + PRESENT_FOR
        expected: dict[int, tuple[datetime, datetime]] = {}
        long_waits: list[tuple[timedelta, datetime]] = []
        for printer_id, since in waiting_since.items():
            waited = max(now - since, timedelta(0))
            if self.present_until is not None and last_clear is not None and since >= last_clear:
                # Finished after someone cleared a plate a moment ago: they clear this one too.
                expected[printer_id] = (since, now + clear)
                continue
            usual = self.learned.long_after(since) if self.learned is not None else timedelta(0)
            is_long = waited > max(LONG_WAIT_MIN, usual)
            remaining = self.learned.remaining(since, waited) if self.learned is not None else None
            if remaining is None:
                remaining = min(waited, GUESS_MAX) if is_long else clear
            ready = max(now + remaining, self.next_staffed(now) + clear)
            expected[printer_id] = (since, ready)
            if is_long and (last_clear is None or last_clear < since):
                # Nobody has cleared anything since this plate finished.
                long_waits.append((waited, ready))
        if long_waits:
            # Going by the plate that has waited longest, whoever comes next clears them all.
            self.away_until = max(long_waits)[1]
            self.present_until = None
        for printer_id, (since, ready) in expected.items():
            if self.away_until is not None and self.away_until >= ready:
                self.waiting[printer_id] = (since, self.away_until, "away")
            else:
                self.waiting[printer_id] = (since, ready, "waiting")

    def typical_at(self, print_end: datetime) -> timedelta | None:
        """How long a plate finished then usually waits, when learned."""
        return self.learned.typical(print_end) if self.learned is not None else None

    def explain(self, print_end: datetime) -> tuple[datetime, str]:
        """When the next job can start after a print ending at ``print_end``, and why then.

        The reason is ``none`` (nobody waits for a plate), ``clear`` (only the
        clearing), ``unstaffed`` (nobody is there until the staffed hours),
        ``typical`` (how long plates usually wait then) or ``away`` (nobody
        seems to be there now).
        """
        if not self.waits_for_plate:
            return print_end, "none"
        clear = self._clear()
        if self.present_until is not None and self.now is not None and self.now <= print_end < self.present_until:
            return print_end + clear, "clear"
        staffed = self.next_staffed(print_end)
        ready, reason = staffed + clear, ("unstaffed" if staffed > print_end else "clear")
        typical = self.typical_at(print_end)
        if typical is not None and print_end + typical > ready:
            ready, reason = print_end + typical, "typical"
        if self.away_until is not None and print_end < self.away_until and self.away_until > ready:
            ready, reason = self.away_until, "away"
        return ready, reason

    def someone_there(self) -> tuple[datetime, str]:
        """When someone is expected to be at the printers from now, to start a job by hand,
        and why then.

        The reason is ``present`` (someone cleared a plate a moment ago), ``now``
        (no telling otherwise), ``unstaffed`` (nobody is there until the staffed
        hours), ``typical`` (as long as a plate finished now usually waits) or
        ``away`` (nobody seems to be there now). Staffed hours count with
        plate-clear confirmation off too; what is learned only exists with it on.
        """
        now = self.now or datetime.now(timezone.utc)
        if self.present_until is not None and now < self.present_until:
            return now, "present"
        at = self.next_staffed(now)
        reason = "unstaffed" if at > now else "now"
        typical = self.typical_at(now)
        if typical is not None and now + typical > at:
            at, reason = now + typical, "typical"
        if self.away_until is not None and self.away_until > at:
            at, reason = self.away_until, "away"
        return at, reason

    def ready_after(self, print_end: datetime) -> datetime:
        """When the next job can start on a printer whose print ends at ``print_end``."""
        return self.explain(print_end)[0]

    def waiting_plate(self, printer_id: int) -> tuple[datetime, datetime, str]:
        """For a printer standing with a finished plate now: when it was finished, when it
        is expected to be cleared and why (``waiting``/``away``, or as ``explain``)."""
        if printer_id in self.waiting:
            return self.waiting[printer_id]
        now = self.now or datetime.now(timezone.utc)
        return (now, *self.explain(now))

    def typical_week(self) -> tuple[datetime, list[int]] | None:
        """The usual wait, in minutes, for each of the 168 hours from the current one (UTC)."""
        if self.learned is None or self.now is None:
            return None
        start = self.now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
        return start, [
            int(self.learned.typical(start + timedelta(hours=k, minutes=30)).total_seconds() // 60) for k in range(168)
        ]

    def as_function(self) -> Callable[[datetime], datetime] | None:
        """``ready_after``, or None when nobody waits for anything (the forecast skips it)."""
        if not self.waits_for_plate:
            return None
        if not (
            self.hours.enabled
            or self.hours.clear_minutes
            or self.learned is not None
            or self.away_until is not None
            or self.present_until is not None
        ):
            return None
        return self.ready_after
