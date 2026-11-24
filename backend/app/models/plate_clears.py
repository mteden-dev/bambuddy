"""When each finished plate was cleared (fork).

A fork-only table, created by ``create_all`` like any model: the official image
has no model for it and never reads it, so going back to that image leaves it
behind untouched. See services/plate_clears for what is written and why.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class PlateClear(Base):
    """One print's plate: when the print ended and when someone cleared it.

    Written on the plate-clear gate's edges (``printer_manager``): a row when a
    print ends and the gate goes up, completed when the gate comes down.
    """

    __tablename__ = "custom_plate_clears"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    # The gate went up: the print ended (UTC).
    finished_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    # The gate came down (UTC); None while the plate is still waiting.
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # A queued job was waiting when the print ended, so clearing the plate was
    # what held it up (with nothing queued nobody hurries).
    queue_waiting: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Plate-clear confirmation was on when the gate came down: a person cleared
    # it. Off, the queue drops the gate itself when it starts the next job.
    gated: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
