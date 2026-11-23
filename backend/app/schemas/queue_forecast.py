"""Response of GET /queue/forecast (fork): see services/queue_forecast."""

from datetime import datetime

from pydantic import BaseModel


class QueueForecastPlacement(BaseModel):
    item_id: int
    printer_id: int
    start: datetime
    end: datetime
    # Placed by the forecast for an "Any <model>" job, not pinned by the user.
    projected: bool


class QueueForecastOffTimeline(BaseModel):
    item_id: int
    # manual_start | waiting | no_printer | unassigned | starting
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
    # inactive | model | location | alternatives | scope | tags
    code: str
    detail: str | None = None


class QueueForecastResponse(BaseModel):
    generated_at: datetime
    placements: list[QueueForecastPlacement]
    off_timeline: list[QueueForecastOffTimeline]
    printers: list[QueueForecastPrinter]
    # Keyed by queue item id, then printer id (as strings, JSON object keys):
    # why the job may not be moved onto that printer. A printer that is not
    # listed takes it.
    refusals: dict[str, dict[str, QueueForecastRefusal]]
