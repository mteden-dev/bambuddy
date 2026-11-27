"""Print Anyway cannot get past a forced colour with no tray (fork).

An H2S job forced to FDE #DCDB4E was held: the slot reported #E2DF60. Print
Anyway released it, the matcher still found no tray for the forced slot, and
the print went out with no AMS mapping table at all; the H2S stopped with
0700-8012 "Failed to get AMS mapping table". A printer that picks a spool by
itself could as well have printed it in green. See
print_scheduler.print_anyway_blockers.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services import filament_aliases
from backend.app.services.print_scheduler import PrintScheduler

PRESET = "P1a2b3c4"
FDE_FILE = "#DCDB4E"

H2S_TRAYS = [
    {"global_tray_id": 0, "type": "PETG", "color": "#FFFFFF", "tray_info_idx": "GFG02"},
    {"global_tray_id": 1, "type": "PETG", "color": "#000000", "tray_info_idx": PRESET},
    {"global_tray_id": 2, "type": "PETG", "color": "#408002", "tray_info_idx": PRESET},
    {"global_tray_id": 3, "type": "PETG", "color": "#E2DF60", "tray_info_idx": PRESET},
]


@pytest.fixture(autouse=True)
def no_groups():
    filament_aliases.apply(filament_aliases.Aliases())
    yield
    filament_aliases.apply(filament_aliases.Aliases())


def _req(slot: int, color: str, *, forced: bool) -> dict:
    return {"slot_id": slot, "type": "PETG", "color": color, "tray_info_idx": PRESET, "force_color_match": forced}


def _item(requirements: list[dict], **overrides):
    item = MagicMock()
    item.id = 310
    item.printer_id = 6
    item.archive_id = None
    item.library_file_id = 928
    item.plate_id = None
    item.ams_mapping = None
    item.use_ams = True
    item.skip_filament_check = True
    item.filament_overrides = json.dumps([r for r in requirements if r["force_color_match"]])
    item.manual_start = False
    item.waiting_reason = None
    for key, value in overrides.items():
        setattr(item, key, value)
    return item


def _scheduler(requirements: list[dict]) -> PrintScheduler:
    scheduler = PrintScheduler()
    scheduler._build_loaded_filaments = MagicMock(return_value=[dict(t) for t in H2S_TRAYS])
    scheduler._get_filament_requirements = AsyncMock(return_value=[dict(r) for r in requirements])
    scheduler._get_bool_setting = AsyncMock(return_value=False)
    scheduler._get_job_name = AsyncMock(return_value="762x39 Bottom")
    scheduler._get_printer = AsyncMock(return_value=MagicMock(model="H2S"))
    return scheduler


async def _dispatch_checks(scheduler: PrintScheduler, item, status=True) -> bool:
    db = AsyncMock()
    with patch("backend.app.services.print_scheduler.printer_manager") as pm:
        pm.get_status.return_value = (
            MagicMock(raw_data={"ams": [{"id": 0}]}, ams_filament_backup=None) if status else None
        )
        await scheduler._ensure_ams_mapping(db, item.printer_id, item)
        return await scheduler._block_on_unmatched_filament(db, item)


@pytest.mark.asyncio
async def test_the_reported_h2s_job_is_held_again_instead_of_going_out_without_a_mapping():
    requirements = [_req(1, FDE_FILE, forced=True)]
    scheduler = _scheduler(requirements)
    item = _item(requirements)

    assert await _dispatch_checks(scheduler, item) is True
    assert item.manual_start is True
    assert item.waiting_reason == f"Needs PETG {FDE_FILE}"
    # The acknowledgement is spent: once the spool is there, nothing is in the way.
    assert item.skip_filament_check is False


@pytest.mark.asyncio
async def test_it_goes_out_once_the_colours_are_marked_as_the_same():
    requirements = [_req(1, FDE_FILE, forced=True)]
    filament_aliases.apply(filament_aliases.clean({"colors": [[FDE_FILE, "#E2DF60"]]}))
    scheduler = _scheduler(requirements)
    item = _item(requirements)

    assert await _dispatch_checks(scheduler, item) is False
    assert json.loads(item.ams_mapping) == [3]


@pytest.mark.asyncio
async def test_a_forced_slot_with_no_tray_holds_though_another_slot_has_one():
    requirements = [_req(1, FDE_FILE, forced=True), _req(2, "#000000", forced=True)]
    scheduler = _scheduler(requirements)
    item = _item(requirements)

    assert await _dispatch_checks(scheduler, item) is True
    assert item.waiting_reason == f"Needs PETG {FDE_FILE}"


@pytest.mark.asyncio
async def test_an_unforced_slot_with_no_tray_still_lets_the_printer_choose():
    """Print Anyway as it was for a job that asked for no colour: one slot has its tray."""
    requirements = [_req(1, "#123456", forced=False), _req(2, "#000000", forced=False)]
    scheduler = _scheduler(requirements)
    item = _item(requirements, ams_mapping=json.dumps([-1, 1]))
    blockers = await scheduler.print_anyway_blockers(AsyncMock(), item, [-1, 1])
    assert blockers == []


@pytest.mark.asyncio
async def test_a_print_with_no_tray_at_all_is_held_forced_or_not():
    """Out with no mapping table, every printer stops with 0700-8012."""
    requirements = [_req(1, "#123456", forced=False)]
    scheduler = _scheduler(requirements)
    item = _item(requirements)
    with patch("backend.app.services.print_scheduler.printer_manager") as pm:
        pm.get_status.return_value = MagicMock(raw_data={"ams": [{"id": 0}]})
        assert await scheduler.print_anyway_blockers(AsyncMock(), item, None) == ["PETG #123456"]
        # Not when the print does not use the AMS, nor without a status to judge by.
        assert await scheduler.print_anyway_blockers(AsyncMock(), _item(requirements, use_ams=False), None) == []
        pm.get_status.return_value = None
        assert await scheduler.print_anyway_blockers(AsyncMock(), item, None) == []


@pytest.mark.asyncio
async def test_start_asks_afresh():
    requirements = [_req(1, FDE_FILE, forced=True)]
    scheduler = _scheduler(requirements)
    item = _item(requirements, ams_mapping=json.dumps([3]))  # a stored mapping is not what Start goes by
    with patch("backend.app.services.print_scheduler.printer_manager") as pm:
        pm.get_status.return_value = MagicMock(raw_data={"ams": [{"id": 0}]}, ams_filament_backup=None)
        blockers = await scheduler.print_anyway_blockers(AsyncMock(), item, from_request=True)
    assert blockers == [f"PETG {FDE_FILE}"]
