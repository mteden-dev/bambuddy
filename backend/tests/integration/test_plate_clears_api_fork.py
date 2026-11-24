"""Recording plate clears, learning from them, and the forecast going by it (fork, services/plate_clears.py)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.plate_clears import PlateClear
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services.plate_clears import load_samples, record_gate_change_in

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def _naive(t: datetime) -> datetime:
    return t.astimezone(timezone.utc).replace(tzinfo=None)


def _live(connected: set[int], printing: dict[int, int], awaiting: set[int] = frozenset()):
    def status(printer_id: int):
        if printer_id in printing:
            return SimpleNamespace(state="RUNNING", remaining_time=printing[printer_id], progress=50)
        return SimpleNamespace(state="IDLE", remaining_time=0, progress=0)

    from backend.app.services.printer_manager import printer_manager

    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=status),
        patch.object(printer_manager, "is_awaiting_plate_clear", side_effect=lambda pid: pid in awaiting),
    )


def _plates(printer_id: int, now: datetime, wait: timedelta, count: int = 12) -> list[PlateClear]:
    """Plates cleared over the last weeks, each after ``wait``, a job queued every time."""
    rows = []
    for k in range(count):
        finished = _naive(now - timedelta(days=2 + 3 * k, hours=k))
        rows.append(
            PlateClear(
                printer_id=printer_id,
                finished_at=finished,
                cleared_at=finished + wait,
                queue_waiting=True,
                gated=True,
            )
        )
    return rows


class TestRecording:
    async def test_a_plate_from_the_print_ending_to_its_clearing(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory(name="P1S-A", model="P1S")
        archive = await archive_factory(printer.id)
        db_session.add_all(
            [
                PrintQueueItem(archive_id=archive.id, status="pending", position=1),
                Settings(key="require_plate_clear", value="true"),
            ]
        )
        await db_session.commit()
        end = datetime(2026, 11, 23, 13, 0, tzinfo=timezone.utc)

        await record_gate_change_in(db_session, printer.id, True, end)
        await db_session.commit()
        await record_gate_change_in(db_session, printer.id, False, end + timedelta(minutes=40))
        await db_session.commit()

        [row] = (await db_session.execute(select(PlateClear))).scalars().all()
        assert (row.printer_id, row.finished_at, row.cleared_at) == (
            printer.id,
            _naive(end),
            _naive(end + timedelta(minutes=40)),
        )
        assert row.queue_waiting is True
        assert row.gated is True

    async def test_a_clearing_with_no_recorded_end_takes_it_from_the_history(
        self, db_session, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="P1S-A", model="P1S")
        end = datetime(2026, 11, 23, 13, 0)
        await archive_factory(printer.id, completed_at=end)

        await record_gate_change_in(
            db_session, printer.id, False, (end + timedelta(hours=1)).replace(tzinfo=timezone.utc)
        )
        await db_session.commit()

        [row] = (await db_session.execute(select(PlateClear))).scalars().all()
        assert (row.finished_at, row.cleared_at, row.gated) == (end, end + timedelta(hours=1), False)

    async def test_a_gate_raised_again_keeps_only_the_latest_plate(self, db_session, printer_factory):
        printer = await printer_factory(name="P1S-A", model="P1S")
        first = datetime(2026, 11, 23, 13, 0, tzinfo=timezone.utc)

        await record_gate_change_in(db_session, printer.id, True, first)
        await record_gate_change_in(db_session, printer.id, True, first + timedelta(hours=2))
        await db_session.commit()

        [row] = (await db_session.execute(select(PlateClear))).scalars().all()
        assert row.finished_at == _naive(first + timedelta(hours=2))
        assert row.queue_waiting is False

    async def test_the_printer_manager_records_each_edge(self, printer_factory):
        from backend.app.services.printer_manager import printer_manager

        printer = await printer_factory(name="P1S-A", model="P1S")
        scheduled = []
        printer_manager._awaiting_plate_clear.discard(printer.id)
        with (
            patch.object(printer_manager, "_loop", asyncio.get_running_loop()),
            patch.object(printer_manager, "_schedule_async", side_effect=scheduled.append),
        ):
            printer_manager.set_awaiting_plate_clear(printer.id, True)
            printer_manager.set_awaiting_plate_clear(printer.id, True)  # no change, no edge
            printer_manager.set_awaiting_plate_clear(printer.id, False)
        recorded = [c.cr_frame.f_locals["awaiting"] for c in scheduled if c.__qualname__ == "record_gate_change"]
        for coro in scheduled:
            coro.close()

        assert recorded == [True, False]


class TestHistory:
    async def test_a_print_end_to_the_next_queued_job_that_was_already_waiting(
        self, db_session, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="P1S-A", model="P1S")
        pid = printer.id
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        job_file = await archive_factory(pid)

        def day(n: int, hour: int = 12) -> datetime:
            return (now - timedelta(days=n)).replace(hour=hour, minute=0, second=0, microsecond=0)

        # Waited 45 minutes for someone: counts.
        await archive_factory(pid, started_at=day(10, 9), completed_at=day(10))
        counted = PrintQueueItem(
            archive_id=job_file.id,
            printer_id=pid,
            status="completed",
            position=1,
            created_at=day(10, 8),
            started_at=day(10) + timedelta(minutes=45),
        )
        # Queued after the print ended: nothing was waiting.
        await archive_factory(pid, started_at=day(8, 9), completed_at=day(8))
        queued_later = PrintQueueItem(
            archive_id=job_file.id,
            printer_id=pid,
            status="completed",
            position=2,
            created_at=day(8, 13),
            started_at=day(8, 14),
        )
        # Started a minute after the end: the queue itself, plate-clear confirmation was off.
        await archive_factory(pid, started_at=day(6, 9), completed_at=day(6))
        at_once = PrintQueueItem(
            archive_id=job_file.id,
            printer_id=pid,
            status="completed",
            position=3,
            created_at=day(6, 8),
            started_at=day(6) + timedelta(minutes=1),
        )
        # Something else was printed in between, its end unknown.
        await archive_factory(pid, started_at=day(4, 9), completed_at=day(4))
        await archive_factory(pid, started_at=day(4, 12) + timedelta(minutes=10), status="cancelled")
        after_another = PrintQueueItem(
            archive_id=job_file.id,
            printer_id=pid,
            status="completed",
            position=4,
            created_at=day(4, 8),
            started_at=day(4, 15),
        )
        db_session.add_all([counted, queued_later, at_once, after_another])
        await db_session.commit()

        samples = await load_samples(db_session, datetime.now(timezone.utc))

        assert [(s.finished_at, s.wait_s) for s in samples] == [(day(10).replace(tzinfo=timezone.utc), 45 * 60)]

    async def test_recorded_plates_take_over_from_the_history(self, db_session, printer_factory, archive_factory):
        printer = await printer_factory(name="P1S-A", model="P1S")
        pid = printer.id
        now = datetime.now(timezone.utc)
        end = _naive(now - timedelta(days=3))
        job_file = await archive_factory(pid)
        await archive_factory(pid, started_at=end - timedelta(hours=3), completed_at=end)
        db_session.add_all(
            [
                PrintQueueItem(
                    archive_id=job_file.id,
                    printer_id=pid,
                    status="completed",
                    position=1,
                    created_at=end - timedelta(hours=4),
                    started_at=end + timedelta(minutes=45),
                ),
                # Recording began before that print ended.
                PlateClear(
                    printer_id=pid,
                    finished_at=end - timedelta(days=1),
                    cleared_at=end - timedelta(days=1) + timedelta(minutes=20),
                    queue_waiting=True,
                    gated=True,
                ),
            ]
        )
        await db_session.commit()

        samples = await load_samples(db_session, now)

        assert [s.wait_s for s in samples] == [20 * 60]


class TestForecast:
    async def test_the_forecast_goes_by_how_long_plates_usually_wait(
        self, async_client: AsyncClient, db_session, printer_factory, archive_factory
    ):
        printer = await printer_factory(name="P1S-A", model="P1S")
        printer_id = printer.id
        archive_id = (await archive_factory(printer_id, sliced_for_model="P1S")).id
        item = PrintQueueItem(
            archive_id=archive_id, status="pending", position=1, print_time_seconds=3600, target_model="P1S"
        )
        now = datetime.now(timezone.utc)
        db_session.add_all(
            [item, Settings(key="require_plate_clear", value="true"), *_plates(printer_id, now, timedelta(hours=2))]
        )
        await db_session.commit()
        item_id = item.id

        connected, status, awaiting = _live({printer_id}, printing={printer_id: 30})
        with connected, status, awaiting:
            body = (await async_client.get("/api/v1/queue/forecast")).json()

        [placement] = [p for p in body["placements"] if p["item_id"] == item_id]
        start = datetime.fromisoformat(placement["start"])
        assert abs(start - (now + timedelta(minutes=150))) < timedelta(minutes=1)
        [wait] = [w for w in body["plate_waits"] if w["end"] == placement["start"]]
        assert wait["reason"] == "typical"
        staffed = body["staffed"]
        assert (staffed["learn"], staffed["learned_samples"]) == (True, 12)
        assert staffed["typical"]["minutes"] == [120] * 168
        assert staffed["away_until"] is None

    async def test_a_plate_waiting_far_longer_than_usual_holds_every_printer(
        self, async_client: AsyncClient, db_session, printer_factory, archive_factory
    ):
        standing = await printer_factory(name="P1S-A", model="P1S")
        busy = await printer_factory(name="P1S-B", model="P1S")
        standing_id, busy_id = standing.id, busy.id
        archive_id = (await archive_factory(busy_id, sliced_for_model="P1S")).id
        item = PrintQueueItem(
            archive_id=archive_id, printer_id=busy_id, status="pending", position=1, print_time_seconds=3600
        )
        now = datetime.now(timezone.utc)
        db_session.add_all(
            [
                item,
                Settings(key="require_plate_clear", value="true"),
                *_plates(standing_id, now, timedelta(minutes=20)),
                # Its plate has waited three hours where twenty minutes is usual.
                PlateClear(printer_id=standing_id, finished_at=_naive(now - timedelta(hours=3)), queue_waiting=True),
            ]
        )
        await db_session.commit()
        item_id = item.id

        connected, status, awaiting = _live({standing_id, busy_id}, printing={busy_id: 30}, awaiting={standing_id})
        with connected, status, awaiting:
            body = (await async_client.get("/api/v1/queue/forecast")).json()

        away_until = datetime.fromisoformat(body["staffed"]["away_until"])
        assert abs(away_until - (now + timedelta(hours=3))) < timedelta(minutes=1)
        [standing_wait] = [w for w in body["plate_waits"] if w["printer_id"] == standing_id]
        assert standing_wait["reason"] == "away"
        assert abs(datetime.fromisoformat(standing_wait["start"]) - (now - timedelta(hours=3))) < timedelta(minutes=1)
        # The other printer's print ends in half an hour; its plate waits for whoever comes too.
        [placement] = [p for p in body["placements"] if p["item_id"] == item_id]
        assert datetime.fromisoformat(placement["start"]) == away_until

    async def test_what_was_learned_for_the_staffed_hours_dialog(
        self, async_client: AsyncClient, db_session, printer_factory
    ):
        printer = await printer_factory(name="P1S-A", model="P1S")
        db_session.add_all(_plates(printer.id, datetime.now(timezone.utc), timedelta(minutes=30)))
        await db_session.commit()

        learned = (await async_client.get("/api/v1/queue/staffed-hours")).json()["learned"]

        assert (learned["samples"], learned["needed"]) == (12, 10)
        assert learned["typical_minutes"] == [30] * 168
