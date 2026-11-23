"""A slot whose spool may have been swapped, waiting for the user's answer (fork).

A fork-only table, created by ``create_all`` like any model: the official image
has no model for it and never reads it, so going back to that image leaves it
behind untouched. See services/slot_spools for when a row is written.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class SlotSpoolPrompt(Base):
    """The slot went empty and filled again while its slot spool stayed assigned.

    The printer cannot tell the same roll put back from another one, so the
    slot keeps counting on the assigned spool until the user says which it is.
    A row whose slot no longer holds ``spool_id`` is stale and is ignored.
    """

    __tablename__ = "custom_slot_reload_prompts"
    __table_args__ = (UniqueConstraint("printer_id", "ams_id", "tray_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"))
    ams_id: Mapped[int] = mapped_column(Integer)
    tray_id: Mapped[int] = mapped_column(Integer)
    spool_id: Mapped[int] = mapped_column(ForeignKey("spool.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
