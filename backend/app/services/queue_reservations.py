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

Two writers reserve jobs: the timeline's plan, laid out by hand ("user"), and
the product planner ("plan"), which holds each plate for the printer its plan
chose. The planner's plan goes stale as soon as a plate is cleared late or a
print runs long, so its holds yield: when the printer cannot start the job in a
queue pass and is not about to finish a print (within the margin a preferred
printer gets), the job is offered to the other printers it may run on in the
same pass. Someone's hold never yields.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Generic, TypeVar

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.printer_scope import ALL_PRINTERS, PrinterScope
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.queue_reservations import QueueReservation
from backend.app.models.settings import Settings
from backend.app.utils.printer_models import normalize_printer_model

# Who reserved a job: the product planner, or someone (a row from before the
# column, NULL, counts as someone's).
SOURCE_PLAN = "plan"
SOURCE_USER = "user"
# Settings row; "false" makes the planner's reservations as firm as anyone's.
YIELD_SETTING_KEY = "product_reservation_yield"

# The printer states in which a printer is working through a print.
_PRINTING_STATES = ("RUNNING", "PAUSE", "PREPARE", "SLICING")

T = TypeVar("T")


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


@dataclass(frozen=True)
class YieldRule:
    """When a job the product planner reserved may go to another printer."""

    enabled: bool
    prefer_min_s: int
    prefer_pct: float

    def margin_s(self, print_time_s: int | None) -> float:
        """How soon its printer must be done for the job to keep waiting for it:
        the margin the planner gives a preferred printer."""
        return max(float(self.prefer_min_s), self.prefer_pct / 100 * (print_time_s or 0))


async def read_yield_rule(db: AsyncSession) -> YieldRule:
    # Imported here: services/products imports this module.
    from backend.app.services.products import read_plan_settings

    value = (await db.execute(select(Settings.value).where(Settings.key == YIELD_SETTING_KEY))).scalar_one_or_none()
    plan = await read_plan_settings(db)
    return YieldRule(
        enabled=value is None or value.strip().lower() != "false",
        prefer_min_s=plan.prefer_minutes * 60,
        prefer_pct=float(plan.prefer_pct),
    )


def known_remaining_s(printer_id: int) -> float | None:
    """How long the printer's print has left, when it prints and says so."""
    from backend.app.services.printer_manager import printer_manager

    status = printer_manager.get_status(printer_id)
    if status is None or status.state not in _PRINTING_STATES or not status.remaining_time:
        return None
    return status.remaining_time * 60 if status.remaining_time > 0 else None


class ReservationAttempts(Generic[T]):
    """What one queue pass offers a job: each scope with each of its candidates.

    First ``first`` (the printer it is held for, or its whole scope when no
    hold applies); then, for a soft hold, ``fallback`` (its whole scope) once
    every candidate failed on the first and ``may_yield`` says so. ``yielded``
    tells the caller the second round ran.
    """

    def __init__(
        self,
        first: PrinterScope,
        candidates: list[T],
        fallback: PrinterScope | None = None,
        may_yield: Callable[[], bool] | None = None,
    ):
        self.first = first
        self.candidates = candidates
        self.fallback = fallback
        self.may_yield = may_yield
        self.yielded = False

    def __iter__(self) -> Iterator[tuple[PrinterScope, T]]:
        for candidate in self.candidates:
            yield self.first, candidate
        if self.fallback is None or (self.may_yield is not None and not self.may_yield()):
            return
        self.yielded = True
        for candidate in self.candidates:
            yield self.fallback, candidate


@dataclass
class QueueReservations:
    """The reservations of one set of pending jobs, and what decides if each holds."""

    # item id -> printer id, for pending jobs not pinned to a printer
    rows: dict[int, int] = field(default_factory=dict)
    printers: dict[int, Printer] = field(default_factory=dict)
    # Printers that can take work now: connected, or woken by an Auto On plug.
    usable: frozenset[int] = frozenset()
    # item id -> who reserved it (SOURCE_PLAN, SOURCE_USER or None)
    sources: dict[int, str | None] = field(default_factory=dict)
    # Read when any job is the planner's: whether and when its hold yields.
    rule: YieldRule | None = None

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
        sources: dict[int, str | None] = {}
        for row in stored:
            created_at = _created_at(by_id[row.queue_item_id])
            if row.item_created_at is not None and created_at is not None and row.item_created_at != created_at:
                continue  # left by a deleted job whose id this one was given
            rows[row.queue_item_id] = row.printer_id
            sources[row.queue_item_id] = row.source
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
        rule = await read_yield_rule(db) if SOURCE_PLAN in sources.values() else None
        return cls(rows=rows, printers=printers, usable=usable, sources=sources, rule=rule)

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

    def is_soft(self, item: PrintQueueItem) -> bool:
        """Whether ``item``'s reservation is the planner's and yields (see the module docstring)."""
        return (
            self.stored_printer(item) is not None
            and self.sources.get(item.id) == SOURCE_PLAN
            and self.rule is not None
            and self.rule.enabled
        )

    def yield_margin_s(self, item: PrintQueueItem) -> float:
        """How soon a soft hold's printer must be done for the job to keep waiting for it."""
        return self.rule.margin_s(item.print_time_seconds) if self.rule is not None else 0.0

    def may_yield(self, item: PrintQueueItem, printer_id: int) -> bool:
        """Whether soft-held ``item`` may go elsewhere now its printer cannot start it:
        not while that printer prints with a known remaining time within the margin."""
        remaining = known_remaining_s(printer_id)
        return remaining is None or remaining > self.yield_margin_s(item)

    def attempts(self, item: PrintQueueItem, scope: PrinterScope, candidates: list[T]) -> ReservationAttempts[T]:
        """The scopes one queue pass offers ``item`` (``scope`` before its reservation)."""
        first = self.narrow(item, scope)
        printer_id = self.active_printer(item, scope)
        if printer_id is None or not self.is_soft(item):
            return ReservationAttempts(first, candidates)
        return ReservationAttempts(first, candidates, scope, lambda: self.may_yield(item, printer_id))


async def reserve(db: AsyncSession, item: PrintQueueItem, printer_id: int, *, source: str = SOURCE_USER) -> None:
    """Hold ``item`` for ``printer_id``. ``item`` must be flushed; the caller commits.

    ``source`` says who: the planner (SOURCE_PLAN) does not take over someone's
    hold on the same printer, which stays theirs.
    """
    if _created_at(item) is None:
        await db.refresh(item, ["created_at"])
    existing = await db.get(QueueReservation, item.id)
    if existing is None:
        db.add(
            QueueReservation(
                queue_item_id=item.id, printer_id=printer_id, item_created_at=item.created_at, source=source
            )
        )
    else:
        someones = (
            source == SOURCE_PLAN
            and existing.source == SOURCE_USER
            and existing.printer_id == printer_id
            and existing.item_created_at in (None, item.created_at)
        )
        existing.printer_id = printer_id
        existing.item_created_at = item.created_at
        if not someones:
            existing.source = source


async def release(db: AsyncSession, item_id: int) -> bool:
    """End ``item_id``'s reservation, if it has one. The caller commits."""
    result = await db.execute(delete(QueueReservation).where(QueueReservation.queue_item_id == item_id))
    return bool(result.rowcount)


async def release_finished(db: AsyncSession) -> None:
    """Drop the rows of jobs that are no longer waiting (started, done, removed)."""
    waiting = select(PrintQueueItem.id).where(PrintQueueItem.status == "pending")
    await db.execute(delete(QueueReservation).where(QueueReservation.queue_item_id.not_in(waiting)))
