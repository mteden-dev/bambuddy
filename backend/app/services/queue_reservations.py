"""Jobs held for one printer by the queue timeline's plan (fork).

The timeline forecasts where each "Any <model>" job will run. In its plan mode
the user moves jobs between printers and in the order, and applying the plan
reserves each moved job for the printer it was put on: the scheduler hands an
"Any" job to whichever matching printer frees up first, so without that a job
moved onto a printer would end up on another as soon as the printers finished
in another order than forecast (a plate cleared late, a print running long).

A reservation is a soft pin:

- the scheduler offers the job only that printer, so it waits for it as a
  pinned job waits for its own, and the timeline keeps it on that lane;
- the job stays "Any <model>". The reservation ends when the job starts, when
  it is pinned or given another model or location, or when someone releases it;
- it is not kept to while the printer cannot take the job: disabled, offline
  with no Auto On plug to wake it, of another model than the job's files, out of
  the job's location, or refused by the creator's printers or by printer tags.
  The job is then any printer's again, and starting elsewhere ends the
  reservation.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.printer_scope import ALL_PRINTERS, PrinterScope
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.queue_reservations import QueueReservation
from backend.app.utils.printer_models import normalize_printer_model


def model_key(model: str | None) -> str:
    return (normalize_printer_model(model) or model or "").strip().lower()


def job_models(item: PrintQueueItem) -> set[str]:
    """The models an "Any" job may run on: its alternatives' (#671) or its target model."""
    variants = item.__dict__.get("variants")  # never lazy-load on an async session
    if variants:
        return {model_key(v.target_model) for v in variants if v.target_model}
    return {model_key(item.target_model)} if item.target_model else set()


def _created_at(item: PrintQueueItem):
    return item.__dict__.get("created_at")


@dataclass
class QueueReservations:
    """The reservations of one set of pending jobs, and what decides if each holds."""

    # item id -> printer id, for pending jobs not pinned to a printer
    rows: dict[int, int] = field(default_factory=dict)
    printers: dict[int, Printer] = field(default_factory=dict)
    # Printers that can take work now: connected, or woken by an Auto On plug.
    usable: frozenset[int] = frozenset()

    @classmethod
    async def load(
        cls, db: AsyncSession, items: Iterable[PrintQueueItem], *, wakeable: Iterable[int] | None = None
    ) -> QueueReservations:
        by_id = {item.id: item for item in items if item.status == "pending" and item.printer_id is None}
        if not by_id:
            return cls()
        stored = (
            (await db.execute(select(QueueReservation).where(QueueReservation.queue_item_id.in_(by_id))))
            .scalars()
            .all()
        )
        rows: dict[int, int] = {}
        for row in stored:
            created_at = _created_at(by_id[row.queue_item_id])
            if row.item_created_at is not None and created_at is not None and row.item_created_at != created_at:
                continue  # left by a deleted job whose id this one was given
            rows[row.queue_item_id] = row.printer_id
        if not rows:
            return cls()
        printers = {
            p.id: p
            for p in (await db.execute(select(Printer).where(Printer.id.in_(set(rows.values()))))).scalars().all()
        }
        if wakeable is None:
            from backend.app.services.print_scheduler import scheduler

            wakeable = await scheduler._wakeable_printer_ids(db)
        from backend.app.services.printer_manager import printer_manager

        wakeable = set(wakeable)
        usable = frozenset(pid for pid in printers if printer_manager.is_connected(pid) or pid in wakeable)
        return cls(rows=rows, printers=printers, usable=usable)

    def stored_printer(self, item: PrintQueueItem) -> int | None:
        """The printer ``item`` is reserved for, whether or not that holds now."""
        return self.rows.get(item.id) if item.printer_id is None else None

    def active_printer(self, item: PrintQueueItem, scope: PrinterScope = ALL_PRINTERS) -> int | None:
        """The printer ``item`` waits for, or None when it is any printer's.

        ``scope`` is what else limits the job's printers (its creator's printers
        and printer tags): a reservation outside it is not kept to, rather than
        leaving the job no printer at all.
        """
        printer_id = self.stored_printer(item)
        printer = self.printers.get(printer_id) if printer_id is not None else None
        if printer is None or not printer.is_active or printer_id not in self.usable:
            return None
        if model_key(printer.model) not in job_models(item):
            return None
        if item.target_location and (printer.location or "") != item.target_location:
            return None
        return printer_id if scope.allows(printer_id) else None

    def narrow(self, item: PrintQueueItem, scope: PrinterScope) -> PrinterScope:
        """``scope`` cut down to the printer ``item`` is held for, when it is."""
        printer_id = self.active_printer(item, scope)
        return scope if printer_id is None else PrinterScope(frozenset({printer_id}))


async def reserve(db: AsyncSession, item: PrintQueueItem, printer_id: int) -> None:
    """Hold ``item`` for ``printer_id``. ``item`` must be flushed; the caller commits."""
    if _created_at(item) is None:
        await db.refresh(item, ["created_at"])
    existing = await db.get(QueueReservation, item.id)
    if existing is None:
        db.add(QueueReservation(queue_item_id=item.id, printer_id=printer_id, item_created_at=item.created_at))
    else:
        existing.printer_id = printer_id
        existing.item_created_at = item.created_at


async def release(db: AsyncSession, item_id: int) -> bool:
    """End ``item_id``'s reservation, if it has one. The caller commits."""
    result = await db.execute(delete(QueueReservation).where(QueueReservation.queue_item_id == item_id))
    return bool(result.rowcount)


async def release_finished(db: AsyncSession) -> None:
    """Drop the rows of jobs that are no longer waiting (started, done, removed)."""
    waiting = select(PrintQueueItem.id).where(PrintQueueItem.status == "pending")
    await db.execute(delete(QueueReservation).where(QueueReservation.queue_item_id.not_in(waiting)))
