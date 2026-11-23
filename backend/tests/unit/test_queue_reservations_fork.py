"""The queue timeline's plan holds "Any <model>" jobs for a printer (fork).

services/queue_reservations.py: a reserved job waits for its printer, as a
pinned one does, while that printer can take it; services/queue_plan.py orders
the queue so the scheduler takes the jobs as the plan lays them out.
"""

from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.queue_reservations import QueueReservation
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.queue_forecast import ForecastJob, ForecastPrinter, place_jobs
from backend.app.services.queue_plan import planned_order
from backend.app.services.queue_reservations import QueueReservations, release, reserve

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)
HOUR = 3600


@pytest.fixture
async def farm():
    """Three P1S printers (1 is the least worn, so an "Any" job's first pick) and an H2S."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    async with session_maker() as db:
        db.add_all(
            [
                Printer(
                    id=pid,
                    name=f"{model}-{pid}",
                    serial_number=f"SN000{pid}",
                    ip_address=f"192.0.2.{pid}",
                    access_code="x",
                    model=model,
                    location=location,
                    is_active=True,
                    runtime_seconds=pid * 3600,
                )
                for pid, model, location in ((1, "P1S", None), (2, "P1S", None), (3, "P1S", "Left"), (4, "H2S", None))
            ]
        )
        db.add(
            LibraryFile(
                id=10, filename="cube.gcode.3mf", file_path="/l/cube.gcode.3mf", file_size=1, file_type="gcode.3mf"
            )
        )
        await db.commit()
    try:
        yield SimpleNamespace(session_maker=session_maker)
    finally:
        await engine.dispose()


async def _add_job(ctx, *, reserved_for: int | None = None, **extra) -> int:
    async with ctx.session_maker() as db:
        item = PrintQueueItem(status="pending", position=1, target_model="P1S", library_file_id=10, **extra)
        db.add(item)
        await db.flush()
        if reserved_for is not None:
            await reserve(db, item, reserved_for)
        await db.commit()
        return item.id


async def _load(db, item_id):
    return (
        await db.execute(
            select(PrintQueueItem).where(PrintQueueItem.id == item_id).options(selectinload(PrintQueueItem.variants))
        )
    ).scalar_one()


async def _reservations(ctx, item_id, *, connected=frozenset({1, 2, 3, 4}), wakeable=()):
    async with ctx.session_maker() as db:
        item = await _load(db, item_id)
        with patch(
            "backend.app.services.printer_manager.printer_manager.is_connected",
            MagicMock(side_effect=lambda pid: pid in connected),
        ):
            return item, await QueueReservations.load(db, [item], wakeable=wakeable)


class TestWhenAReservationHolds:
    async def test_it_holds_for_a_printer_of_the_jobs_model_that_can_work(self, farm):
        item, reservations = await _reservations(farm, await _add_job(farm, reserved_for=2))
        assert reservations.active_printer(item) == 2
        assert reservations.narrow(item, PrinterScope()).printer_ids == frozenset({2})

    async def test_an_offline_printer_holds_only_with_an_auto_on_plug(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        item, reservations = await _reservations(farm, item_id, connected=frozenset({1}))
        assert reservations.active_printer(item) is None
        item, reservations = await _reservations(farm, item_id, connected=frozenset({1}), wakeable={2})
        assert reservations.active_printer(item) == 2

    async def test_not_on_a_disabled_printer(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        async with farm.session_maker() as db:
            (await db.get(Printer, 2)).is_active = False
            await db.commit()
        item, reservations = await _reservations(farm, item_id)
        assert reservations.active_printer(item) is None

    async def test_not_on_another_model_nor_outside_the_jobs_location(self, farm):
        item, reservations = await _reservations(farm, await _add_job(farm, reserved_for=4))
        assert reservations.active_printer(item) is None
        item, reservations = await _reservations(farm, await _add_job(farm, reserved_for=2, target_location="Left"))
        assert reservations.active_printer(item) is None

    async def test_not_outside_what_else_limits_the_job(self, farm):
        item, reservations = await _reservations(farm, await _add_job(farm, reserved_for=2))
        # The creator's printers and printer tags: the job keeps them, not the reservation.
        scope = PrinterScope(frozenset({1, 3}))
        assert reservations.active_printer(item, scope) is None
        assert reservations.narrow(item, scope) is scope

    async def test_a_pinned_job_has_none(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        async with farm.session_maker() as db:
            (await db.get(PrintQueueItem, item_id)).printer_id = 1
            await db.commit()
        item, reservations = await _reservations(farm, item_id)
        assert reservations.stored_printer(item) is None

    async def test_a_row_left_by_a_deleted_job_is_ignored(self, farm):
        item_id = await _add_job(farm)
        async with farm.session_maker() as db:
            db.add(QueueReservation(queue_item_id=item_id, printer_id=2, item_created_at=datetime(2000, 1, 1)))
            await db.commit()
        item, reservations = await _reservations(farm, item_id)
        assert reservations.stored_printer(item) is None

    async def test_release(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        async with farm.session_maker() as db:
            assert await release(db, item_id) is True
            await db.commit()
            assert await release(db, item_id) is False


class TestQueuePass:
    async def _pass(self, ctx, idle: dict[int, bool] | None = None, connected=frozenset({1, 2, 3, 4})):
        scheduler = PrintScheduler()
        launched = MagicMock()
        patches = [
            patch("backend.app.services.print_scheduler.async_session", ctx.session_maker),
            patch("backend.app.core.database.async_session", ctx.session_maker),
            patch(
                "backend.app.services.print_scheduler.printer_manager.is_connected",
                MagicMock(side_effect=lambda pid: pid in connected),
            ),
            patch("backend.app.services.print_scheduler.printer_manager.get_status", lambda pid: None),
            patch(
                "backend.app.services.print_scheduler.ha_sensor_manager.blocked_printers",
                AsyncMock(return_value={}),
            ),
            patch(
                "backend.app.services.notification_service.notification_service.on_queue_job_waiting",
                AsyncMock(),
            ),
            patch(
                "backend.app.services.notification_service.notification_service.on_queue_job_assigned",
                AsyncMock(),
            ),
            patch("backend.app.services.print_scheduler.compute_deficit_for_queue_item", AsyncMock(return_value=[])),
            patch.object(scheduler, "_filament_short_on", AsyncMock(return_value=False)),
            patch.object(
                scheduler,
                "_is_printer_idle",
                MagicMock(side_effect=lambda pid, *_: True if idle is None else idle[pid]),
            ),
            patch.object(scheduler, "_check_auto_drying", AsyncMock()),
            patch.object(scheduler, "_ensure_ams_mapping", AsyncMock(return_value=None)),
            patch.object(scheduler, "_block_on_unmatched_filament", AsyncMock(return_value=False)),
            patch.object(scheduler, "_unmatched_on", AsyncMock(return_value=[])),
            patch.object(scheduler, "_launch_uploads", launched),
            patch.object(scheduler, "_dispatch_one", AsyncMock()),
        ]
        with ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            await scheduler.check_queue()
        return launched

    async def test_without_a_reservation_the_least_worn_printer_takes_it(self, farm):
        item_id = await _add_job(farm)
        launched = await self._pass(farm)
        assert launched.call_args[0][1] == {item_id: 1}

    async def test_a_reserved_job_goes_to_its_printer(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        launched = await self._pass(farm)
        assert launched.call_args[0][1] == {item_id: 2}

    async def test_it_waits_for_its_printer_while_another_is_free(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        launched = await self._pass(farm, idle={1: True, 2: False, 3: True, 4: True})

        launched.assert_not_called()
        async with farm.session_maker() as db:
            item = await _load(db, item_id)
        assert item.printer_id is None
        assert item.waiting_reason == "Busy: P1S-2"

    async def test_a_reservation_on_an_offline_printer_is_not_kept_to(self, farm):
        item_id = await _add_job(farm, reserved_for=2)
        launched = await self._pass(farm, connected=frozenset({1, 3, 4}))
        assert launched.call_args[0][1] == {item_id: 1}


class TestForecast:
    def test_a_reserved_job_waits_for_its_printer(self):
        printers = [
            ForecastPrinter(id=1, model="P1S"),
            ForecastPrinter(id=2, model="P1S", free_at=NOW + timedelta(hours=2)),
        ]
        job = ForecastJob(id=10, target_model="P1S", duration_s=HOUR, reserved_printer_id=2)

        [placement], _ = place_jobs([job], printers, NOW)

        assert (placement.printer_id, placement.start, placement.reserved, placement.projected) == (
            2,
            NOW + timedelta(hours=2),
            True,
            True,
        )


class TestPlannedOrder:
    """Ordered by when the plan starts them, the forecast lays the jobs out as planned."""

    def _replay(self, lanes, printers, reserved=()):
        rank = {p.id: i for i, p in enumerate(printers)}
        by_id = {job.id: job for _, jobs in lanes for job in jobs}
        for job_id in reserved:
            printer_id = next(p.id for p, jobs in lanes if any(j.id == job_id for j in jobs))
            by_id[job_id].reserved_printer_id = printer_id
        order = planned_order(lanes, rank, NOW)
        placements, _ = place_jobs([by_id[i] for i in order], printers, NOW)
        laid_out = {}
        for p in sorted(placements, key=lambda p: p.start):
            laid_out.setdefault(p.printer_id, []).append(p.item_id)
        return order, laid_out

    def test_any_jobs_land_where_the_plan_puts_them(self):
        printers = [
            ForecastPrinter(id=1, model="P1S"),
            ForecastPrinter(id=2, model="P1S", free_at=NOW + timedelta(minutes=30)),
            ForecastPrinter(id=3, model="P1S", free_at=NOW + timedelta(hours=2.5)),
        ]
        job = {i: ForecastJob(id=i, target_model="P1S", duration_s=HOUR * (1 + i % 2)) for i in range(1, 7)}
        lanes = [
            (printers[0], [job[4], job[1]]),
            (printers[1], [job[6], job[2], job[3]]),
            (printers[2], [job[5]]),
        ]

        order, laid_out = self._replay(lanes, printers)

        assert laid_out == {1: [4, 1], 2: [6, 2, 3], 3: [5]}
        assert order[0] == 4  # printer 1 is free first

    def test_a_printer_whose_lane_ends_first_takes_the_next_job(self):
        # Why applying a plan also reserves such a job (queue_plan): the
        # scheduler hands a free printer the next job, wherever the plan put it.
        printers = [
            ForecastPrinter(id=1, model="P1S"),
            ForecastPrinter(id=2, model="P1S", free_at=NOW + timedelta(hours=2)),
        ]
        a, b = ForecastJob(id=1, target_model="P1S", duration_s=HOUR), ForecastJob(id=2, target_model="P1S")

        _, laid_out = self._replay([(printers[0], [a]), (printers[1], [b])], printers)
        assert laid_out == {1: [1, 2]}

        _, laid_out = self._replay([(printers[0], [a]), (printers[1], [b])], printers, reserved=[2])
        assert laid_out == {1: [1], 2: [2]}

    def test_equal_starts_go_in_the_printers_pick_order(self):
        printers = [ForecastPrinter(id=1, model="P1S"), ForecastPrinter(id=2, model="P1S")]
        a, b = ForecastJob(id=1, target_model="P1S"), ForecastJob(id=2, target_model="P1S")

        # Both free now: the second printer gets the first job only if it comes second.
        order, laid_out = self._replay([(printers[0], [b]), (printers[1], [a])], printers)

        assert order == [2, 1]
        assert laid_out == {1: [2], 2: [1]}

    def test_a_reserved_job_stays_on_its_lane_when_its_printer_frees_late(self):
        printers = [ForecastPrinter(id=1, model="P1S"), ForecastPrinter(id=2, model="P1S")]
        a, b = ForecastJob(id=1, target_model="P1S", duration_s=HOUR), ForecastJob(id=2, target_model="P1S")
        lanes = [(printers[0], [a]), (printers[1], [b])]
        order = planned_order(lanes, {1: 0, 2: 1}, NOW)
        # Printer 2 now runs an hour late: an unreserved job would go to printer 1.
        late = [printers[0], ForecastPrinter(id=2, model="P1S", free_at=NOW + timedelta(hours=1))]
        b.reserved_printer_id = 2

        placements, _ = place_jobs([{1: a, 2: b}[i] for i in order], late, NOW)

        assert {p.item_id: p.printer_id for p in placements} == {1: 1, 2: 2}
