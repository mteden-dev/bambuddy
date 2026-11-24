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

Weeks differ too: tonight nobody stays, next Sunday someone comes in. Marks on
given dates say so: a stretch when nobody is there (``away``) or someone is
(``here``), whatever the weekly hours say. Someone who marks a stretch knows
it, so where a mark covers a plate's end the forecast goes by it instead of
by what it learned; everywhere else the history still counts, since a mark is
easily forgotten. What is going on now still has the last word: a plate
cleared during a marked absence means somebody is there after all, and a
plate still waiting well after someone was marked to be back means they are
not.

Stored as one settings row, which the official image ignores.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
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
_STAMP = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$")
MARK_KINDS = ("away", "here")
MAX_MARKS = 200
MAX_MARK_LENGTH = timedelta(days=31)
# Marks that ended longer ago than this are dropped when the hours are saved.
KEEP_MARKS = timedelta(days=2)
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


@dataclass(frozen=True)
class Mark:
    """A stretch on given dates when nobody is there (``away``) or someone is (``here``).

    ``start`` and ``end`` are wall-clock "YYYY-MM-DDTHH:MM" in the farm's zone.
    """

    start: str
    end: str
    kind: str = "away"

    @property
    def here(self) -> bool:
        return self.kind == "here"


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
    # Given dates when nobody is there or someone is, whatever the weekly hours say.
    marks: list[Mark] = field(default_factory=list)

    def zone(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            return ZoneInfo("UTC")

    def mark_spans(self, start: datetime, end: datetime) -> list[tuple[datetime, datetime, Mark]]:
        """The marks overlapping ``start``..``end``, in UTC, in order."""
        zone = self.zone()
        found = []
        for mark in self.marks:
            opens, closes = _stamp(mark.start, zone), _stamp(mark.end, zone)
            if closes > opens and closes > start and opens < end:
                found.append((opens, closes, mark))
        found.sort(key=lambda span: (span[0], span[1]))
        return found

    def windows(self, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
        """The staffed stretches overlapping ``start``..``end``, in UTC, in order.

        The weekly hours (around the clock when they are not used), with the
        marks laid over them: someone is there in a stretch marked ``here``,
        nobody in one marked ``away`` (that wins where the two overlap). Empty
        with neither weekly hours nor marks.
        """
        spans = self.mark_spans(start, end)
        if not self.enabled and not spans:
            return []
        base = self._weekly(start, end) if self.enabled else [(start, end)]
        here = [(opens, closes) for opens, closes, mark in spans if mark.here]
        away = [(opens, closes) for opens, closes, mark in spans if not mark.here]
        return _subtract(_union(base + here), away)

    def _weekly(self, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
        """The weekly hours' stretches overlapping ``start``..``end``, in UTC, in order."""
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
            "marks": [{"start": m.start, "end": m.end, "kind": m.kind} for m in self.marks],
        }

    def without_old_marks(self, now: datetime) -> StaffedHours:
        """The same hours without the marks that ended a while ago."""
        zone = self.zone()
        kept = [m for m in self.marks if _stamp(m.end, zone) > now - KEEP_MARKS]
        return replace(self, marks=kept)


def _at(day, hhmm: str, zone: ZoneInfo) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone).astimezone(timezone.utc)


def _stamp(value: str, zone: ZoneInfo) -> datetime:
    """A wall-clock "YYYY-MM-DDTHH:MM" in ``zone``, as UTC."""
    return datetime.fromisoformat(value).replace(tzinfo=zone).astimezone(timezone.utc)


def _union(spans: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    """The stretches merged where they overlap or touch, in order."""
    merged: list[tuple[datetime, datetime]] = []
    for opens, closes in sorted(spans):
        if merged and opens <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], closes))
        else:
            merged.append((opens, closes))
    return merged


def _subtract(spans: list[tuple[datetime, datetime]], cuts: list[tuple[datetime, datetime]]):
    """``spans`` without ``cuts``, in order."""
    left = spans
    for cut_from, cut_to in cuts:
        rest: list[tuple[datetime, datetime]] = []
        for opens, closes in left:
            if cut_to <= opens or cut_from >= closes:
                rest.append((opens, closes))
                continue
            if opens < cut_from:
                rest.append((opens, cut_from))
            if cut_to < closes:
                rest.append((cut_to, closes))
        left = rest
    return left


def _parse_marks(entries) -> list[Mark]:
    """Marks as sent or stored; a malformed one is left out."""
    marks: list[Mark] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        start, end, kind = str(entry.get("start")), str(entry.get("end")), entry.get("kind", "away")
        if kind not in MARK_KINDS or not _STAMP.match(start) or not _STAMP.match(end):
            continue
        try:
            length = datetime.fromisoformat(end) - datetime.fromisoformat(start)
        except ValueError:  # 31 February
            continue
        if timedelta(0) < length <= MAX_MARK_LENGTH:
            marks.append(Mark(start, end, kind))
    marks.sort(key=lambda m: (m.start, m.end))
    return marks[-MAX_MARKS:]


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
        marks=_parse_marks(data.get("marks")),
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
    # The marks from a day back to the horizon, in UTC: (start, end, someone is there).
    marks: list[tuple[datetime, datetime, bool]] = field(default_factory=list)

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
        start, end = now - timedelta(days=1), now + HORIZON
        turnaround = cls(
            hours,
            hours.windows(start, end),
            waits_for_plate,
            now,
            learned if hours.learn else None,
            learned_samples,
            marks=[(opens, closes, mark.here) for opens, closes, mark in hours.mark_spans(start, end)],
        )
        if waits_for_plate and hours.learn:
            turnaround._read_the_room(waiting_since or {}, last_clear)
        return turnaround

    def _clear(self) -> timedelta:
        return timedelta(minutes=self.hours.clear_minutes)

    def next_staffed(self, t: datetime) -> datetime:
        """The first moment at or after ``t`` someone is there (``t`` without staffed hours or marks)."""
        if not self.windows:
            return t
        for opens, closes in self.windows:
            if closes > t:
                return max(t, opens)
        return t  # past the horizon: no telling

    def mark_at(self, t: datetime) -> bool | None:
        """Whether a mark says someone is there at ``t`` (True), nobody is (False), or none covers it."""
        found = None
        for opens, closes, here in self.marks:
            if opens <= t < closes:
                if not here:
                    return False  # an absence wins over a presence it overlaps
                found = True
        return found

    def _unstaffed_reason(self, t: datetime, staffed: datetime) -> str:
        """Why nobody is there from ``t`` until ``staffed``: ``absent`` (marked so, or
        the wait ends with a marked absence) or ``unstaffed`` (the weekly hours)."""
        if self.mark_at(t) is False:
            return "absent"
        if any(not here and closes == staffed and opens < staffed for opens, closes, here in self.marks):
            return "absent"
        return "unstaffed"

    def _marked_due(self, since: datetime, now: datetime) -> datetime | None:
        """When, going by the marks, someone was or is to be there for a plate finished at ``since``.

        Past ``now`` while a marked absence goes on: when it is over (and the
        weekly hours after it). Otherwise the latest moment up to ``now`` a mark
        has someone come: the plate's own end in a marked stretch, the start of
        a stretch marked ``here``, the end of one marked ``away``. None when no
        mark says anything about the plate.
        """
        if self.mark_at(now) is False:
            return self.next_staffed(now)
        moments = [since] if self.mark_at(since) is not None else []
        for opens, closes, here in self.marks:
            moment = opens if here else closes
            if since < moment <= now:
                moments.append(moment)
        return self.next_staffed(max(moments)) if moments else None

    def _read_the_room(self, waiting_since: dict[int, datetime], last_clear: datetime | None) -> None:
        """Work out from the plates waiting now and the last one cleared who is there."""
        now = self.now
        assert now is not None
        clear = self._clear()
        if last_clear is not None and last_clear + PRESENT_FOR > now:
            self.present_until = last_clear + PRESENT_FOR
        expected: dict[int, tuple[datetime, datetime, str]] = {}
        long_waits: list[tuple[timedelta, datetime]] = []
        for printer_id, since in waiting_since.items():
            waited = max(now - since, timedelta(0))
            if self.present_until is not None and last_clear is not None and since >= last_clear:
                # Finished after someone cleared a plate a moment ago: they clear this one too.
                expected[printer_id] = (since, now + clear, "waiting")
                continue
            due = self._marked_due(since, now)
            if due is not None:
                # A mark says when someone is there for this plate.
                if now - due <= LONG_WAIT_MIN:
                    reason = "absent" if due > now else "waiting"
                    expected[printer_id] = (since, max(now, due) + clear, reason)
                    continue
                # Someone was to be there by then and the plate still waits: they are not.
                is_long = True
                remaining = self.learned.remaining(since, waited) if self.learned is not None else None
                if remaining is None:
                    remaining = min(now - due, GUESS_MAX)
                cleared_since = last_clear is not None and last_clear >= due
            else:
                usual = self.learned.long_after(since) if self.learned is not None else timedelta(0)
                is_long = waited > max(LONG_WAIT_MIN, usual)
                remaining = self.learned.remaining(since, waited) if self.learned is not None else None
                if remaining is None:
                    remaining = min(waited, GUESS_MAX) if is_long else clear
                cleared_since = last_clear is not None and last_clear >= since
            ready = max(now + remaining, self.next_staffed(now) + clear)
            expected[printer_id] = (since, ready, "waiting")
            if is_long and not cleared_since:
                # Nobody has cleared anything since this plate was to be cleared.
                long_waits.append((waited, ready))
        if long_waits:
            # Going by the plate that has waited longest, whoever comes next clears them all.
            self.away_until = max(long_waits)[1]
            self.present_until = None
        for printer_id, (since, ready, reason) in expected.items():
            if self.away_until is not None and self.away_until >= ready:
                self.waiting[printer_id] = (since, self.away_until, "away")
            else:
                self.waiting[printer_id] = (since, ready, reason)

    def typical_at(self, print_end: datetime) -> timedelta | None:
        """How long a plate finished then usually waits, when learned."""
        return self.learned.typical(print_end) if self.learned is not None else None

    def _go_by_history(self, t: datetime, ready: datetime, reason: str, clear: timedelta) -> tuple[datetime, str]:
        """``ready`` pushed back to how long a plate finished at ``t`` usually waits, unless a mark says otherwise.

        A mark covering ``t`` says who is there, so the history does not count
        then. Nor past a stretch marked ``here``: someone is there to clear it.
        A usual wait running into a marked absence lasts until it is over.
        """
        typical = self.typical_at(t)
        if typical is None or self.mark_at(t) is not None or t + typical <= ready:
            return ready, reason
        usual, why = t + typical, "typical"
        here_from = min((opens for opens, _closes, here in self.marks if here and t < opens < usual), default=None)
        if here_from is not None:
            usual = min(usual, self.next_staffed(here_from) + clear)
        elif self.mark_at(usual) is False:
            usual, why = self.next_staffed(usual) + clear, "absent"
        return (usual, why) if usual > ready else (ready, reason)

    def explain(self, print_end: datetime) -> tuple[datetime, str]:
        """When the next job can start after a print ending at ``print_end``, and why then.

        The reason is ``none`` (nobody waits for a plate), ``clear`` (only the
        clearing), ``unstaffed`` (nobody is there until the staffed hours),
        ``absent`` (nobody is there, as marked), ``typical`` (how long plates
        usually wait then) or ``away`` (nobody seems to be there now).
        """
        if not self.waits_for_plate:
            return print_end, "none"
        clear = self._clear()
        if self.present_until is not None and self.now is not None and self.now <= print_end < self.present_until:
            return print_end + clear, "clear"
        staffed = self.next_staffed(print_end)
        ready = staffed + clear
        reason = self._unstaffed_reason(print_end, staffed) if staffed > print_end else "clear"
        ready, reason = self._go_by_history(print_end, ready, reason, clear)
        if self.away_until is not None and print_end < self.away_until and self.away_until > ready:
            ready, reason = self.away_until, "away"
        return ready, reason

    def someone_there(self) -> tuple[datetime, str]:
        """When someone is expected to be at the printers from now, to start a job by hand,
        and why then.

        The reason is ``present`` (someone cleared a plate a moment ago), ``now``
        (no telling otherwise), ``unstaffed`` (nobody is there until the staffed
        hours), ``absent`` (nobody is there, as marked), ``typical`` (as long as
        a plate finished now usually waits) or ``away`` (nobody seems to be there
        now). Staffed hours and marks count with plate-clear confirmation off
        too; what is learned only exists with it on.
        """
        now = self.now or datetime.now(timezone.utc)
        if self.present_until is not None and now < self.present_until:
            return now, "present"
        at = self.next_staffed(now)
        reason = self._unstaffed_reason(now, at) if at > now else "now"
        at, reason = self._go_by_history(now, at, reason, timedelta(0))
        if self.away_until is not None and self.away_until > at:
            at, reason = self.away_until, "away"
        return at, reason

    def ready_after(self, print_end: datetime) -> datetime:
        """When the next job can start on a printer whose print ends at ``print_end``."""
        return self.explain(print_end)[0]

    def waiting_plate(self, printer_id: int) -> tuple[datetime, datetime, str]:
        """For a printer standing with a finished plate now: when it was finished, when it
        is expected to be cleared and why (``waiting``/``away``/``absent``, or as ``explain``)."""
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
            self.windows
            or self.hours.clear_minutes
            or self.learned is not None
            or self.away_until is not None
            or self.present_until is not None
        ):
            return None
        return self.ready_after
