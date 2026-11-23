"""A queued "Any <model>" job held for one printer from the timeline (fork).

A fork-only table, created by ``create_all`` like any model: the official image
has no model for it and never reads it, so going back to that image leaves it
behind untouched, and the jobs go back to any printer of their model. See
services/queue_reservations for the rule.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class QueueReservation(Base):
    """The printer a job's plan on the queue timeline holds it for.

    Unlike pinning, the job stays "Any <model>": the reservation ends when the
    job starts, when it is pinned or given another model or location, or when
    someone releases it, and is not kept to while the printer cannot take work.
    """

    __tablename__ = "custom_queue_reservations"

    queue_item_id: Mapped[int] = mapped_column(ForeignKey("print_queue.id", ondelete="CASCADE"), primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), nullable=False)
    # The job's own created_at when the row was written. SQLite gives a freed
    # queue id to the next job, and the official image (which knows nothing of
    # this table) would leave the row behind: a row whose job was created at
    # another moment belongs to a deleted job and is ignored.
    item_created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
