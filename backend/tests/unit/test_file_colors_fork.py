"""Every queued job asks for its file's colours (fork).

A green tray added by hand for "any P1S" went out on a P1S that had only FDE
loaded: nobody ticked "Force colour match", so the queue matched the type alone
and gave the green slot an FDE spool. See services/file_colors and
print_scheduler._force_file_colors.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.settings import Settings
from backend.app.services import filament_aliases, file_colors
from backend.app.services.print_scheduler import PrintScheduler

GREEN = "#408002"
TRAY_GREEN = [{"slot_id": 1, "type": "PETG", "color": GREEN, "tray_info_idx": "GFG99", "used_grams": 163.0}]


def _forced(slot: int, color: str, **extra) -> dict:
    return {"slot_id": slot, "type": "PETG", "color": color, "force_color_match": True, **extra}


# --- the overrides -----------------------------------------------------------


def test_a_job_with_no_overrides_asks_for_every_printed_slot():
    reqs = [*TRAY_GREEN, {"slot_id": 3, "type": "PETG", "color": "#000000", "used_grams": 4.0}]
    assert json.loads(file_colors.forced_overrides(None, reqs)) == [_forced(1, GREEN), _forced(3, "#000000")]


def test_no_profile_is_asked_for():
    """P1S files carry GFG99 while the AMS reports another profile for the same filament."""
    (entry,) = json.loads(file_colors.forced_overrides(None, TRAY_GREEN))
    assert "tray_info_idx" not in entry


def test_a_slot_changed_by_hand_asks_for_the_colour_picked():
    raw = json.dumps(
        [{"slot_id": 1, "type": "PETG", "color": "#E2DF60", "color_name": "FDE", "force_color_match": False}]
    )
    assert json.loads(file_colors.forced_overrides(raw, TRAY_GREEN)) == [_forced(1, "#E2DF60", color_name="FDE")]


def test_nothing_to_change():
    forced = json.dumps([_forced(1, GREEN)])
    assert file_colors.forced_overrides(forced, TRAY_GREEN) is None
    # A file that cannot be read, a row that is not a list of overrides.
    assert file_colors.forced_overrides(None, None) is None
    assert file_colors.forced_overrides(None, []) is None
    assert file_colors.forced_overrides("not json", TRAY_GREEN) is None
    assert file_colors.forced_overrides('{"slot_id": 1}', TRAY_GREEN) is None


def test_slots_the_plate_does_not_print_are_left_alone():
    """A forced slot the plate never prints would still have to be loaded."""
    raw = json.dumps([{"slot_id": 4, "type": "PETG", "color": "#FFFFFF", "force_color_match": False}])
    reqs = [
        *TRAY_GREEN,
        {"slot_id": 0, "type": "PETG", "color": "#000000"},
        {"slot_id": 2, "type": "", "color": "#000000"},
    ]
    assert json.loads(file_colors.forced_overrides(raw, reqs)) == [
        {"slot_id": 4, "type": "PETG", "color": "#FFFFFF", "force_color_match": False},
        _forced(1, GREEN),
    ]


def test_the_reported_job_no_longer_fits_the_fde_printer():
    """002 had FDE in three slots and white in the fourth; 005 had green."""
    overrides = json.loads(file_colors.forced_overrides(None, TRAY_GREEN))

    def trays(*colors):
        return {
            "ams": [{"id": 0, "tray": [{"id": i, "tray_type": "PETG", "tray_color": c} for i, c in enumerate(colors)]}]
        }

    filament_aliases.apply(filament_aliases.Aliases())
    scheduler = PrintScheduler()
    assert scheduler._get_missing_force_color_slots(3, overrides, trays("E2DF60FF", "E2DF60FF", "E2DF60FF", "FFFFFFFF"))
    assert not scheduler._get_missing_force_color_slots(2, overrides, trays("FFFFFFFF", "000000FF", "408002FF"))


# --- the scheduler -------------------------------------------------------------


@pytest.fixture
async def ctx():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield SimpleNamespace(maker=maker)
    finally:
        await engine.dispose()


async def _setting(ctx, on: bool) -> None:
    async with ctx.maker() as db:
        row = (await db.execute(select(Settings).where(Settings.key == file_colors.SETTING_KEY))).scalar_one_or_none()
        if row:
            row.value = "true" if on else "false"
        else:
            db.add(Settings(key=file_colors.SETTING_KEY, value="true" if on else "false"))
        await db.commit()


async def _library_file(db, name: str) -> LibraryFile:
    lib = LibraryFile(filename=name, file_path=f"/library/{name}", file_size=10, file_type="gcode.3mf")
    db.add(lib)
    await db.flush()
    return lib


async def _item(ctx, **columns) -> int:
    async with ctx.maker() as db:
        lib = await _library_file(db, "AB-223 Tray.green.4szt.gcode.3mf")
        item = PrintQueueItem(status="pending", position=1, target_model="P1S", library_file_id=lib.id, **columns)
        db.add(item)
        await db.commit()
        return item.id


async def _overrides(ctx, model, row_id):
    async with ctx.maker() as db:
        raw = (await db.execute(select(model.filament_overrides).where(model.id == row_id))).scalar_one()
    return json.loads(raw) if raw else None


async def _pass(ctx, scheduler, reqs=TRAY_GREEN) -> AsyncMock:
    read = AsyncMock(side_effect=lambda db, source: [dict(r) for r in reqs])
    with (
        patch("backend.app.services.print_scheduler.async_session", ctx.maker),
        patch.object(scheduler, "_get_filament_requirements", read),
    ):
        await scheduler._force_file_colors()
    return read


@pytest.mark.asyncio
async def test_off_by_default_leaves_jobs_alone(ctx):
    item_id = await _item(ctx)
    read = await _pass(ctx, PrintScheduler())
    assert await _overrides(ctx, PrintQueueItem, item_id) is None
    read.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_a_job_added_by_hand_asks_for_its_colours(ctx):
    await _setting(ctx, True)
    item_id = await _item(ctx)
    staged = await _item(ctx, manual_start=True)
    no_ams = await _item(ctx, use_ams=False)
    async with ctx.maker() as db:
        db.add(PrintQueueItem(status="printing", position=2, target_model="P1S"))
        await db.commit()

    await _pass(ctx, PrintScheduler())

    assert await _overrides(ctx, PrintQueueItem, item_id) == [_forced(1, GREEN)]
    assert await _overrides(ctx, PrintQueueItem, staged) == [_forced(1, GREEN)]
    assert await _overrides(ctx, PrintQueueItem, no_ams) is None


@pytest.mark.asyncio
async def test_a_file_is_read_again_only_when_someone_changes_the_job(ctx):
    await _setting(ctx, True)
    item_id = await _item(ctx)
    scheduler = PrintScheduler()
    await _pass(ctx, scheduler)
    assert (await _pass(ctx, scheduler)).await_count == 0

    # Someone unticks it in the edit dialog: it asks again on the next pass.
    async with ctx.maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        item.filament_overrides = json.dumps(
            [{"slot_id": 1, "type": "PETG", "color": GREEN, "force_color_match": False}]
        )
        await db.commit()
    assert (await _pass(ctx, scheduler)).await_count == 1
    assert await _overrides(ctx, PrintQueueItem, item_id) == [_forced(1, GREEN)]


@pytest.mark.asyncio
async def test_an_edit_made_meanwhile_is_not_overwritten(ctx):
    await _setting(ctx, True)
    item_id = await _item(ctx)
    edited = [{"slot_id": 1, "type": "PETG", "color": "#000000", "force_color_match": True}]

    async def read_while_someone_edits(db, source):
        async with ctx.maker() as other:
            item = await other.get(PrintQueueItem, item_id)
            item.filament_overrides = json.dumps(edited)
            await other.commit()
        return [dict(r) for r in TRAY_GREEN]

    scheduler = PrintScheduler()
    with (
        patch("backend.app.services.print_scheduler.async_session", ctx.maker),
        patch.object(scheduler, "_get_filament_requirements", AsyncMock(side_effect=read_while_someone_edits)),
    ):
        await scheduler._force_file_colors()
    assert await _overrides(ctx, PrintQueueItem, item_id) == edited


@pytest.mark.asyncio
async def test_each_variant_asks_for_its_own_file(ctx):
    await _setting(ctx, True)
    async with ctx.maker() as db:
        item = PrintQueueItem(status="pending", position=1, target_model="P1S")
        db.add(item)
        await db.flush()
        for position, (model, name) in enumerate((("P1S", "p1s.gcode.3mf"), ("H2S", "h2s.gcode.3mf"))):
            lib = await _library_file(db, name)
            db.add(
                PrintQueueVariant(
                    queue_item_id=item.id, position=position, library_file_id=lib.id, target_model=model, plate_id=1
                )
            )
        await db.commit()
        item_id = item.id

    read = await _pass(ctx, PrintScheduler())

    assert read.await_count == 2
    assert {(c.args[1].library_file_id, c.args[1].plate_id) for c in read.await_args_list} == {(1, 1), (2, 1)}
    async with ctx.maker() as db:
        variants = (
            (await db.execute(select(PrintQueueVariant).where(PrintQueueVariant.queue_item_id == item_id)))
            .scalars()
            .all()
        )
    assert [json.loads(v.filament_overrides) for v in variants] == [[_forced(1, GREEN)], [_forced(1, GREEN)]]
    assert await _overrides(ctx, PrintQueueItem, item_id) is None


@pytest.mark.asyncio
async def test_a_failure_never_stops_the_queue(ctx):
    await _setting(ctx, True)
    item_id = await _item(ctx)
    scheduler = PrintScheduler()
    with (
        patch("backend.app.services.print_scheduler.async_session", ctx.maker),
        patch.object(scheduler, "_get_filament_requirements", AsyncMock(side_effect=OSError("gone"))),
    ):
        await scheduler._force_file_colors()
    assert await _overrides(ctx, PrintQueueItem, item_id) is None


@pytest.mark.asyncio
async def test_check_queue_asks_before_it_looks_at_a_printer(ctx):
    scheduler = PrintScheduler()
    order: list[str] = []
    with (
        patch.object(scheduler, "_force_file_colors", AsyncMock(side_effect=lambda: order.append("colours"))),
        patch(
            "backend.app.services.print_scheduler.async_session",
            side_effect=lambda: order.append("pass") or ctx.maker(),
        ),
        patch("backend.app.services.print_scheduler.filament_aliases.refresh", AsyncMock()),
        patch.object(scheduler, "_check_scheduled_dryings", AsyncMock()),
        patch.object(scheduler, "_check_auto_drying", AsyncMock()),
        patch.object(scheduler, "_check_filament_low", AsyncMock()),
        patch.object(scheduler, "_check_stock_forecast", AsyncMock()),
    ):
        await scheduler.check_queue()
    assert order[:2] == ["colours", "pass"]
