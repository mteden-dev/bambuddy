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

Stored as one settings row, which the official image ignores.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.db_dialect import upsert_setting
from backend.app.models.settings import Settings

logger = logging.getLogger(__name__)

SETTINGS_KEY = "queue_staffed_hours"
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
# How far ahead the staffed windows are worked out (the forecast rarely goes further).
HORIZON = timedelta(days=14)
MAX_CLEAR_MINUTES = 240


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

    @classmethod
    def build(cls, hours: StaffedHours, waits_for_plate: bool, now: datetime) -> PlateTurnaround:
        return cls(hours, hours.windows(now - timedelta(days=1), now + HORIZON), waits_for_plate)

    def next_staffed(self, t: datetime) -> datetime:
        """The first moment at or after ``t`` someone is there (``t`` without staffed hours)."""
        if not self.hours.enabled or not self.windows:
            return t
        for opens, closes in self.windows:
            if closes > t:
                return max(t, opens)
        return t  # past the horizon: no telling

    def ready_after(self, print_end: datetime) -> datetime:
        """When the next job can start on a printer whose print ends at ``print_end``."""
        if not self.waits_for_plate:
            return print_end
        return self.next_staffed(print_end) + timedelta(minutes=self.hours.clear_minutes)

    def as_function(self) -> Callable[[datetime], datetime] | None:
        """``ready_after``, or None when nobody waits for anything (the forecast skips it)."""
        if not self.waits_for_plate or (not self.hours.enabled and not self.hours.clear_minutes):
            return None
        return self.ready_after
