"""Printer tags one queued job asks for, picked in the print dialog (fork).

A fork-only table, created by ``create_all`` like any model: the official image
has no model for it and never reads it, so going back to that image leaves it
behind untouched. See services/printer_tags for how tags route jobs.
"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class QueueItemTagOverride(Base):
    """The tags a job was given by hand instead of its file's.

    No row: the job asks for its library file's printer tags, read at each
    queue pass. A row with an empty list asks for none, whatever the file has.
    """

    __tablename__ = "custom_queue_item_tags"

    queue_item_id: Mapped[int] = mapped_column(ForeignKey("print_queue.id", ondelete="CASCADE"), primary_key=True)
    tag_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # The job's own created_at when the row was written. SQLite gives a freed
    # queue id to the next job, and the official image (which knows nothing of
    # this table) would leave the row behind: a row whose job was created at
    # another moment belongs to a deleted job and is ignored.
    item_created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
