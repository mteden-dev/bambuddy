"""GET /queue/forecast and POST /queue/plan (fork): see services/queue_forecast
and services/queue_plan."""

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from backend.app.schemas.not_null import IgnoresNullForRequiredColumns


class QueueForecastVariant(BaseModel):
    """The printer alternative (#671) a placed job prints on its printer."""

    library_file_id: int
    target_model: str
    name: str | None = None
    plate_id: int | None = None
    has_thumbnail: bool = False
    print_time_seconds: int | None = None


class QueueForecastPlacement(BaseModel):
    item_id: int
    printer_id: int
    start: datetime
    end: datetime
    # Placed by the forecast for an "Any <model>" job, not pinned by the user.
    projected: bool
    # For a job with alternatives: the one this printer's model takes.
    variant: QueueForecastVariant | None = None
    # An "Any" job the timeline's plan holds for this printer.
    reserved: bool = False


class QueueForecastOffTimeline(BaseModel):
    item_id: int
    # waiting | no_printer | unassigned | starting (manual_start from older forecasts)
    reason: str
    detail: str | None = None


class QueueForecastPrinter(BaseModel):
    printer_id: int
    free_at: datetime
    available: bool
    connected: bool
    external_print: bool
    awaiting_plate_clear: bool


class QueueForecastRefusal(BaseModel):
    # inactive | model | location | alternatives | scope | tags | offline
    code: str
    detail: str | None = None


class QueueForecastPlateWait(BaseModel):
    """A printer standing with a finished print on its plate until someone clears it."""

    printer_id: int
    start: datetime
    end: datetime
    # Why until then: clear (only the clearing), unstaffed (outside the staffed
    # hours), typical (how long plates usually wait then), and for a plate
    # waiting now, waiting (as usual) or away (far longer than usual: nobody
    # seems to be there).
    reason: str = "clear"


class QueueForecastWindow(BaseModel):
    start: datetime
    end: datetime


class QueueForecastTypical(BaseModel):
    """How long a plate usually waits, in minutes, for each hour from ``start`` on.

    168 values, one per hour from the current one (UTC); the week repeats.
    """

    start: datetime
    minutes: list[int]


class QueueForecastStaffed(BaseModel):
    """When someone is there to clear plates (services/staffed_hours.py)."""

    enabled: bool
    # Staffed stretches from a day back to two weeks ahead (empty when not enabled).
    windows: list[QueueForecastWindow]
    clear_minutes: int
    # Plate-clear confirmation is on, so a printer waits for it after each print.
    waits_for_plate: bool
    # What the forecast learned (services/plate_clears.py), when it goes by it.
    learn: bool = False
    learned_samples: int = 0
    typical: QueueForecastTypical | None = None
    # Nobody seems to be there until then: a plate finished before it waits for it.
    away_until: datetime | None = None
    # Someone cleared a plate a moment ago: a print ending before then is cleared at once.
    present_until: datetime | None = None
    # When someone is expected to be there to start a job by hand
    # (PlateTurnaround.someone_there): a job waiting for a manual start goes on
    # the lanes from then. The reason is present | now | unstaffed | typical | away.
    someone_there_at: datetime | None = None
    someone_there_reason: str | None = None


class QueueForecastReservation(BaseModel):
    printer_id: int
    active: bool


class QueueForecastResponse(BaseModel):
    generated_at: datetime
    placements: list[QueueForecastPlacement]
    off_timeline: list[QueueForecastOffTimeline]
    printers: list[QueueForecastPrinter]
    # Keyed by queue item id, then printer id (as strings, JSON object keys):
    # why the job may not be pinned to that printer. A printer that is not
    # listed takes it.
    refusals: dict[str, dict[str, QueueForecastRefusal]]
    # Likewise for "Any" jobs: why the plan may not hold the job for that
    # printer (the scheduler's rule for "Any" jobs, and a printer that can work).
    reserve_refusals: dict[str, dict[str, QueueForecastRefusal]] = {}
    # Keyed by queue item id: the printer the plan reserved the job for, and
    # whether that holds now (not while that printer cannot take the job).
    reservations: dict[str, QueueForecastReservation] = {}
    # Keyed by queue item id: a job's alternatives (#671), each with its file and time.
    variants: dict[str, list[QueueForecastVariant]] = {}
    # Printers standing with a finished plate: now, and after each forecast print.
    plate_waits: list[QueueForecastPlateWait] = []
    staffed: QueueForecastStaffed | None = None


class QueueStaffedDay(BaseModel):
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, value: str) -> str:
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("expected HH:MM")
        return value


class QueueStaffedHours(IgnoresNullForRequiredColumns):
    """GET/PUT /queue/staffed-hours (fork)."""

    # Written as JSON into one settings row, so there are no columns to tell
    # which fields can't be null: none can, and a null counts as not sent
    # (a day of ``days`` may still be null, nobody there).
    __orm_table__ = "settings"

    enabled: bool = False
    # IANA time zone the hours are wall-clock times in, e.g. "Europe/Warsaw".
    timezone: str = "UTC"
    # Monday first; null is a day nobody is there. An end at or before the start runs past midnight.
    days: list[QueueStaffedDay | None] = Field(min_length=7, max_length=7)
    clear_minutes: int = Field(default=0, ge=0, le=240)
    # Also go by how long plates actually wait, and by what is going on now.
    learn: bool = True

    @model_validator(mode="before")
    @classmethod
    def _ignore_null_for_required_columns(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        return {key: value for key, value in data.items() if not (value is None and key in cls.model_fields)}


class QueueStaffedLearned(BaseModel):
    """What the forecast learned from the plates of the last eight weeks."""

    samples: int
    # How many it wants before it goes by them.
    needed: int
    # The usual wait in minutes per hour of the week in ``timezone``, Monday
    # 00:00 first; null until there are enough.
    typical_minutes: list[int] | None = None


class QueueStaffedHoursView(QueueStaffedHours):
    learned: QueueStaffedLearned | None = None


class QueuePlanLane(BaseModel):
    printer_id: int
    # The queued jobs on the printer's lane, in the order it is to print them.
    item_ids: list[int]


class QueuePlanRequest(BaseModel):
    lanes: list[QueuePlanLane]
    # "Any" jobs to hold for the printer whose lane they are on.
    reserve: list[int] = []


class QueuePlanResponse(BaseModel):
    reserved: list[int]
    # Laid out on a lane but forecast elsewhere once applied (a job scheduled
    # for a later time, two printers finishing at once…).
    moved_elsewhere: list[int]
