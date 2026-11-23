"""Printer tags route "Any <model>" queue jobs (fork, services/printer_tags.py).

A printer has tags from the library catalog; a job asks for its file's tags
that some printer carries, or the ones it was given in the print dialog. A
printer takes a job only when it has all of them, and an exclusive printer only
takes jobs asking for one of its tags.
"""

import json
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile, LibraryFileTag, LibraryTag
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.queue_item_tags import QueueItemTagOverride
from backend.app.models.settings import Settings
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_tags import (
    PRINTER_TAGS_KEY,
    PrinterTags,
    TagRouting,
    read_printer_tags,
    set_override,
    write_printer_tags,
)

TRAY, LEFT, TOY = 1, 2, 3


class TestPrinterAccepts:
    def test_an_untagged_printer_takes_untagged_jobs_only(self):
        assert PrinterTags().accepts(frozenset())
        assert not PrinterTags().accepts(frozenset({TRAY}))

    def test_a_printer_needs_every_tag_the_job_asks_for(self):
        printer = PrinterTags(frozenset({TRAY, LEFT}))
        assert printer.accepts(frozenset({TRAY}))
        assert printer.accepts(frozenset({TRAY, LEFT}))
        assert not printer.accepts(frozenset({TRAY, TOY}))

    def test_a_tagged_printer_still_takes_untagged_jobs_unless_exclusive(self):
        assert PrinterTags(frozenset({TRAY})).accepts(frozenset())
        assert not PrinterTags(frozenset({TRAY}), exclusive=True).accepts(frozenset())
        assert PrinterTags(frozenset({TRAY}), exclusive=True).accepts(frozenset({TRAY}))

    def test_exclusive_without_tags_means_nothing(self):
        assert PrinterTags(frozenset(), exclusive=True).accepts(frozenset())


@pytest.fixture
async def farm():
    """Three P1S printers, tags tray / left / toy, one file tagged tray + toy."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    async with session_maker() as db:
        db.add_all(
            [
                Printer(
                    id=pid,
                    name=f"P1S-{pid}",
                    serial_number=f"P1S000{pid}",
                    ip_address=f"192.0.2.{pid}",
                    access_code="x",
                    model="P1S",
                    is_active=True,
                    runtime_seconds=pid * 3600,
                )
                for pid in (1, 2, 3)
            ]
        )
        db.add_all(
            [
                LibraryTag(id=tid, name=name, name_key=name)
                for tid, name in ((TRAY, "tray"), (LEFT, "left"), (TOY, "toy"))
            ]
        )
        db.add_all(
            [
                LibraryFile(
                    id=10, filename="tray.gcode.3mf", file_path="/l/tray.gcode.3mf", file_size=1, file_type="gcode.3mf"
                ),
                LibraryFile(
                    id=11, filename="cube.gcode.3mf", file_path="/l/cube.gcode.3mf", file_size=1, file_type="gcode.3mf"
                ),
            ]
        )
        db.add_all([LibraryFileTag(file_id=10, tag_id=TRAY), LibraryFileTag(file_id=10, tag_id=TOY)])
        await db.commit()
    try:
        yield SimpleNamespace(session_maker=session_maker)
    finally:
        await engine.dispose()


async def _tag_printers(ctx, tags: dict[int, tuple[set[int], bool]]):
    async with ctx.session_maker() as db:
        for pid, (tag_ids, exclusive) in tags.items():
            await write_printer_tags(db, pid, tag_ids, exclusive)
        await db.commit()


async def _add_job(ctx, file_id: int, tags: list[int] | None = None) -> int:
    async with ctx.session_maker() as db:
        item = PrintQueueItem(status="pending", position=1, target_model="P1S", library_file_id=file_id)
        db.add(item)
        await db.flush()
        if tags is not None:
            await set_override(db, item, tags)
        await db.commit()
        return item.id


async def _load(db, item_id):
    return (
        await db.execute(
            select(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .options(
                selectinload(PrintQueueItem.library_file),
                selectinload(PrintQueueItem.archive),
                selectinload(PrintQueueItem.variants),
            )
        )
    ).scalar_one()


async def _routing(ctx, item_id):
    async with ctx.session_maker() as db:
        item = await _load(db, item_id)
        return item, await TagRouting.load(db, [item])


class TestStorage:
    async def test_tags_are_kept_per_printer_and_untagging_removes_the_entry(self, farm):
        await _tag_printers(farm, {1: ({TRAY}, True), 2: ({LEFT}, False)})
        await _tag_printers(farm, {2: (set(), False)})
        async with farm.session_maker() as db:
            assert await read_printer_tags(db) == {1: PrinterTags(frozenset({TRAY}), True)}
            raw = (await db.execute(select(Settings.value).where(Settings.key == PRINTER_TAGS_KEY))).scalar()
        assert json.loads(raw) == {"1": {"tag_ids": [TRAY], "exclusive": True}}

    async def test_a_deleted_catalog_tag_drops_out(self, farm):
        await _tag_printers(farm, {1: ({TRAY, LEFT}, False)})
        async with farm.session_maker() as db:
            await db.delete(await db.get(LibraryTag, LEFT))
            await db.commit()
            assert (await read_printer_tags(db))[1].tag_ids == frozenset({TRAY})

    async def test_a_garbage_row_reads_as_no_tags(self, farm):
        async with farm.session_maker() as db:
            db.add(Settings(key=PRINTER_TAGS_KEY, value="not json"))
            await db.commit()
            assert await read_printer_tags(db) == {}


class TestWhatAJobAsksFor:
    async def test_its_files_tags_that_some_printer_carries(self, farm):
        # "toy" sorts files; no printer has it, so it asks nothing.
        await _tag_printers(farm, {1: ({TRAY}, False)})
        item, routing = await _routing(farm, await _add_job(farm, 10))
        assert routing.wanted(item) == frozenset({TRAY})
        assert not routing.is_overridden(item)

    async def test_nothing_while_no_printer_has_tags(self, farm):
        item, routing = await _routing(farm, await _add_job(farm, 10))
        assert routing.wanted(item) == frozenset()
        assert routing.scope(item).is_unrestricted

    async def test_the_dialogs_tags_replace_the_files(self, farm):
        await _tag_printers(farm, {1: ({TRAY}, False), 2: ({LEFT}, False)})
        item, routing = await _routing(farm, await _add_job(farm, 10, tags=[LEFT]))
        assert routing.wanted(item) == frozenset({LEFT})
        assert routing.is_overridden(item)

    async def test_an_empty_override_asks_for_none(self, farm):
        await _tag_printers(farm, {1: ({TRAY}, False)})
        item, routing = await _routing(farm, await _add_job(farm, 10, tags=[]))
        assert routing.wanted(item) == frozenset()

    async def test_an_override_left_by_a_deleted_job_is_ignored(self, farm):
        await _tag_printers(farm, {1: ({TRAY}, False)})
        item_id = await _add_job(farm, 11)
        async with farm.session_maker() as db:
            from datetime import datetime

            db.add(QueueItemTagOverride(queue_item_id=item_id, tag_ids=[TRAY], item_created_at=datetime(2000, 1, 1)))
            await db.commit()
        item, routing = await _routing(farm, item_id)
        assert routing.wanted(item) == frozenset()

    async def test_deleting_the_job_deletes_its_override(self, farm):
        item_id = await _add_job(farm, 11, tags=[TRAY])
        async with farm.session_maker() as db:
            await db.delete(await db.get(PrintQueueItem, item_id))
            await db.commit()
            assert await db.get(QueueItemTagOverride, item_id) is None


class TestScope:
    async def test_only_printers_with_the_tags(self, farm):
        await _tag_printers(farm, {2: ({TRAY}, False)})
        item, routing = await _routing(farm, await _add_job(farm, 10))
        assert routing.scope(item).printer_ids == frozenset({2})
        assert routing.refusal(item, 1) == {"code": "tags", "detail": "The printer has no printer tag tray"}
        assert routing.refusal(item, 2) is None

    async def test_an_exclusive_printer_refuses_untagged_jobs(self, farm):
        await _tag_printers(farm, {3: ({TRAY}, True)})
        item, routing = await _routing(farm, await _add_job(farm, 11))
        assert routing.scope(item).printer_ids == frozenset({1, 2})
        assert routing.refusal(item, 3) == {"code": "tags", "detail": "The printer only takes jobs tagged tray"}


class TestQueuePass:
    async def _pass(self, ctx, idle: dict[int, bool] | None = None):
        scheduler = PrintScheduler()
        launched = MagicMock()
        patches = [
            patch("backend.app.services.print_scheduler.async_session", ctx.session_maker),
            patch("backend.app.core.database.async_session", ctx.session_maker),
            patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
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

    async def _item(self, ctx, item_id):
        async with ctx.session_maker() as db:
            return await _load(db, item_id)

    async def test_untagged_farm_takes_the_least_worn_printer_as_before(self, farm):
        item_id = await _add_job(farm, 10)
        launched = await self._pass(farm)
        assert launched.call_args[0][1] == {item_id: 1}

    async def test_a_tagged_file_goes_to_the_tagged_printer(self, farm):
        await _tag_printers(farm, {3: ({TRAY}, False)})
        item_id = await _add_job(farm, 10)
        launched = await self._pass(farm)
        assert launched.call_args[0][1] == {item_id: 3}

    async def test_an_exclusive_printer_is_passed_over_for_untagged_jobs(self, farm):
        await _tag_printers(farm, {1: ({TRAY}, True)})
        item_id = await _add_job(farm, 11)
        launched = await self._pass(farm)
        assert launched.call_args[0][1] == {item_id: 2}

    async def test_the_dialogs_tags_win_over_the_files(self, farm):
        await _tag_printers(farm, {2: ({LEFT}, False), 3: ({TRAY}, False)})
        item_id = await _add_job(farm, 10, tags=[LEFT])
        launched = await self._pass(farm)
        assert launched.call_args[0][1] == {item_id: 2}

    async def test_waits_with_a_tag_reason_when_no_printer_has_the_tags(self, farm):
        await _tag_printers(farm, {1: ({LEFT}, False)})
        item_id = await _add_job(farm, 11, tags=[TRAY, LEFT])
        launched = await self._pass(farm)

        launched.assert_not_called()
        item = await self._item(farm, item_id)
        assert item.printer_id is None
        assert item.waiting_reason == (
            "No P1S printer has the printer tags left, tray — tag a printer or edit the job's tags"
        )

    async def test_busy_tagged_printers_keep_the_usual_reason(self, farm):
        await _tag_printers(farm, {2: ({TRAY}, False)})
        item_id = await _add_job(farm, 10)
        launched = await self._pass(farm, idle={1: True, 2: False, 3: True})

        launched.assert_not_called()
        item = await self._item(farm, item_id)
        assert item.waiting_reason is not None
        assert "printer tags" not in item.waiting_reason
