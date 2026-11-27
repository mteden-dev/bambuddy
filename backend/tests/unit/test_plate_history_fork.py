"""How long a plate really prints and how often it fails (fork, services/plate_history.py)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob, ProductPlate
from backend.app.services.plate_history import (
    ItemRow,
    LogRow,
    PlateHistory,
    Run,
    failure_risk,
    job_run,
    learned_duration,
    load_plate_history,
    recorded_estimate,
    summarise,
)

NOW = datetime(2026, 11, 23, 12, 0)
HOUR = 3600


def _ok(real_s: int, estimate_s: int = HOUR, days_ago: float = 1) -> Run:
    return Run(ended_at=NOW - timedelta(days=days_ago), failed=False, real_s=real_s, estimate_s=estimate_s)


class TestDuration:
    def test_the_median_of_the_successful_runs(self):
        runs = [_ok(4000), _ok(3800), _ok(4400)]
        assert learned_duration(runs, HOUR) == 4000

    def test_too_few_runs_leave_the_slicer_s(self):
        assert learned_duration([_ok(4000), _ok(3800)], HOUR) is None
        assert learned_duration([], HOUR) is None

    def test_only_the_latest_ten(self):
        old = [_ok(5000, days_ago=30 + k) for k in range(5)]
        new = [_ok(3700, days_ago=k) for k in range(10)]
        assert learned_duration(old + new, HOUR) == 3700

    def test_failed_runs_do_not_count(self):
        failed = Run(ended_at=NOW, failed=True, real_s=600, estimate_s=HOUR)
        assert learned_duration([failed, failed, _ok(4000), _ok(4000)], HOUR) is None

    def test_a_plate_sliced_again_starts_over(self):
        before = [_ok(5000, estimate_s=4200) for _ in range(5)]
        assert learned_duration(before, HOUR) is None
        # Within 1% is the same slicing (a rounded estimate).
        assert learned_duration([_ok(3900, estimate_s=HOUR + 30)] * 3, HOUR) == 3900

    def test_a_run_far_off_its_estimate_is_left_out(self):
        overnight = _ok(3 * HOUR)
        clock = _ok(HOUR // 3)
        assert learned_duration([overnight, clock, _ok(3800), _ok(3900)], HOUR) is None
        assert learned_duration([overnight, _ok(3800), _ok(3900), _ok(4000)], HOUR) == 3900

    def test_clamped_to_the_current_estimate(self):
        assert learned_duration([_ok(int(1.9 * HOUR))] * 3, HOUR) == int(1.5 * HOUR)
        assert learned_duration([_ok(int(0.55 * HOUR))] * 3, HOUR) == int(0.7 * HOUR)

    def test_no_estimate_learns_nothing(self):
        assert learned_duration([_ok(4000)] * 3, None) is None
        assert learned_duration([_ok(4000)] * 3, 0) is None


class TestRisk:
    def test_no_history_is_two_percent(self):
        assert failure_risk(0, 0) == pytest.approx(0.02)

    def test_never_zero(self):
        assert failure_risk(200, 0) > 0

    def test_smoothed(self):
        assert failure_risk(10, 2) == pytest.approx(2.5 / 35)

    def test_capped_at_a_half(self):
        assert failure_risk(100, 100) == 0.5

    def test_summary(self):
        runs = [_ok(4000), _ok(4000), _ok(4000), Run(ended_at=NOW, failed=True)]
        assert summarise(runs, HOUR) == PlateHistory(duration_s=4000, risk=pytest.approx(1.5 / 29), runs=4)


class TestWhatAJobWas:
    def test_a_job_cancelled_while_it_waited_is_no_run(self):
        item = ItemRow("cancelled", None, NOW, HOUR)
        assert job_run("cancelled", NOW, item, None) is None

    def test_a_start_the_printer_never_took_is_no_run(self):
        assert job_run("failed", NOW, ItemRow("failed", None, NOW, HOUR), None) is None

    def test_a_print_stopped_after_it_started_failed(self):
        item = ItemRow("cancelled", NOW - timedelta(hours=1), NOW, HOUR)
        run = job_run("cancelled", NOW, item, None)
        assert run is not None and run.failed

    def test_the_print_log_s_measured_time_first(self):
        item = ItemRow("completed", NOW - timedelta(seconds=4300), NOW, HOUR)
        assert job_run("done", NOW, item, LogRow("completed", 4000)).real_s == 4000
        # Unmeasured (closed at a reconnect): the queue job's times.
        assert job_run("done", NOW, item, LogRow("completed", 9000, unmeasured=True)).real_s == 4300

    def test_a_deleted_queue_job_counts_by_what_the_print_log_says(self):
        assert job_run("failed", NOW, None, LogRow("failed", 600)).failed
        assert job_run("failed", NOW, None, None) is None
        assert job_run("cancelled", NOW, None, None) is None
        done = job_run("done", NOW, None, LogRow("completed", 4000))
        assert done is not None and not done.failed and done.estimate_s is None

    def test_no_end_is_skipped(self):
        assert job_run("done", None, ItemRow("completed", NOW, NOW, HOUR), None) is None


# ── Loading ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def session_maker():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


_next_id = iter(range(1000, 100000))


def _printed(
    db,
    plate_id: int,
    *,
    real_s: int = 4000,
    estimate_s: int = HOUR,
    days_ago: float = 1,
    item_status: str = "completed",
    job_status: str = "done",
    started: bool = True,
    item_id: int | None = None,
    archive_id: int | None = None,
):
    """A job of the plate and its queue job, ended ``days_ago``."""
    end = NOW - timedelta(days=days_ago)
    created = end - timedelta(seconds=real_s + 600)
    item = PrintQueueItem(
        id=item_id or next(_next_id),
        library_file_id=1,
        status=item_status,
        print_time_seconds=estimate_s,
        created_at=created,
        started_at=end - timedelta(seconds=real_s) if started else None,
        completed_at=end,
        archive_id=archive_id,
    )
    job = ProductJob(
        product_id=1,
        product_plate_id=plate_id,
        queue_item_id=item.id,
        item_created_at=created,
        printer_id=1,
        archive_id=archive_id,
        status=job_status,
        pieces={},
        finished_at=end,
    )
    db.add_all([item, job])
    return item, job


async def _history(session_maker, estimates: dict[int, int]) -> dict[int, PlateHistory]:
    async with session_maker() as db:
        plates = [ProductPlate(id=pid) for pid in estimates]
        return await load_plate_history(db, plates, estimates, now=NOW.replace(tzinfo=timezone.utc))


async def test_every_plate_gets_an_entry(session_maker):
    history = await _history(session_maker, {1: HOUR, 2: HOUR})
    assert history == {
        1: PlateHistory(None, pytest.approx(0.02), 0),
        2: PlateHistory(None, pytest.approx(0.02), 0),
    }


async def test_learns_from_the_plate_s_runs(session_maker):
    async with session_maker() as db:
        for k, real in enumerate((3900, 4000, 4100)):
            _printed(db, 1, real_s=real, days_ago=k + 1)
        _printed(db, 1, job_status="failed", item_status="failed", days_ago=5)
        # Another plate's runs and runs older than 90 days do not count.
        _printed(db, 2, real_s=5000)
        _printed(db, 1, real_s=5000, days_ago=100)
        await db.commit()
    history = await _history(session_maker, {1: HOUR})
    assert history[1] == PlateHistory(4000, pytest.approx(1.5 / 29), 4)


async def test_a_job_cancelled_before_it_started_is_no_run(session_maker):
    async with session_maker() as db:
        _printed(db, 1, job_status="cancelled", item_status="cancelled", started=False)
        _printed(db, 1, job_status="cancelled", item_status="cancelled", days_ago=2)
        await db.commit()
    history = await _history(session_maker, {1: HOUR})
    # Only the stopped one counts, as a failure.
    assert history[1].runs == 1
    assert history[1].risk == pytest.approx(1.5 / 26)


async def test_a_reused_queue_id_is_not_the_job_s(session_maker):
    async with session_maker() as db:
        # An old job's queue job was deleted and its id given to a newer job
        # that has not started: the old job is told by its archive's run.
        item, _ = _printed(db, 1, job_status="failed", item_status="failed", days_ago=10, item_id=7, archive_id=3)
        await db.flush()
        await db.delete(item)
        await db.flush()
        db.add(
            PrintQueueItem(
                id=7, library_file_id=1, status="pending", created_at=NOW - timedelta(hours=1), started_at=None
            )
        )
        db.add(
            PrintLogEntry(
                archive_id=3,
                queue_item_id=7,
                printer_id=1,
                status="failed",
                started_at=NOW - timedelta(days=10, hours=1),
                completed_at=NOW - timedelta(days=10),
                duration_seconds=HOUR,
            )
        )
        # Another old job of the plate with the same reused id and no run in the
        # log: it cannot be told whether it started.
        _, ghost = _printed(db, 1, job_status="failed", item_status="failed", days_ago=20, archive_id=4)
        ghost.queue_item_id = 7
        await db.commit()
    history = await _history(session_maker, {1: HOUR})
    assert history[1].runs == 1
    assert history[1].risk == pytest.approx(1.5 / 26)


async def test_measured_times_and_the_current_slicing(session_maker):
    async with session_maker() as db:
        for k in range(3):
            item, job = _printed(db, 1, real_s=4500, days_ago=k + 1, archive_id=20 + k)
            # The queue job's times hold the upload; the print log's are the print.
            db.add(
                PrintLogEntry(
                    archive_id=20 + k,
                    queue_item_id=item.id,
                    printer_id=1,
                    status="completed",
                    started_at=item.started_at + timedelta(minutes=5),
                    completed_at=item.completed_at,
                    duration_seconds=4200,
                )
            )
        # Runs of an earlier slicing count for the risk only.
        for k in range(3):
            _printed(db, 1, real_s=5000, estimate_s=4800, days_ago=10 + k)
        await db.commit()
    history = await _history(session_maker, {1: HOUR})
    assert history[1].duration_s == 4200
    assert history[1].runs == 6


async def test_the_estimate_recorded_with_the_job_tells_the_slicing(session_maker):
    async with session_maker() as db:
        # The planner's jobs: the queue job carries the learned time it planned
        # with, the job the slicer's estimate.
        for k, real in enumerate((4100, 4200, 4300)):
            _, job = _printed(db, 1, real_s=real, estimate_s=4000, days_ago=k + 1)
            job.plan_info = {"filament": [], "estimate_s": HOUR}
        # A job from before the key: its queue job's estimate, another slicing.
        _printed(db, 1, real_s=5000, estimate_s=4000, days_ago=4)
        # A recorded estimate counts even once its queue job is gone.
        item, job = _printed(db, 1, real_s=4400, estimate_s=HOUR, days_ago=5, archive_id=30)
        job.plan_info = {"estimate_s": HOUR}
        await db.flush()
        await db.delete(item)
        db.add(
            PrintLogEntry(
                archive_id=30,
                printer_id=1,
                status="completed",
                started_at=NOW - timedelta(days=5, seconds=4400),
                completed_at=NOW - timedelta(days=5),
                duration_seconds=4400,
            )
        )
        await db.commit()
    history = await _history(session_maker, {1: HOUR})
    assert history[1].runs == 5
    assert history[1].duration_s == 4250


class TestRecordedEstimate:
    def test_only_a_positive_number(self):
        assert recorded_estimate({"estimate_s": 3600}) == 3600
        assert recorded_estimate({"estimate_s": 3600.4}) == 3600
        for info in (None, {}, {"estimate_s": None}, {"estimate_s": 0}, {"estimate_s": "3600"}, {"estimate_s": True}):
            assert recorded_estimate(info) is None
