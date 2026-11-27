"""Start with Print Anyway says at once when it cannot get past a forced colour (fork).

See print_scheduler.print_anyway_blockers.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from backend.app.models.print_queue import PrintQueueItem

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

BLOCKERS = "backend.app.services.print_scheduler.scheduler.print_anyway_blockers"


async def _staged(db_session, printer_factory) -> PrintQueueItem:
    printer = await printer_factory(model="H2S")
    item = PrintQueueItem(status="pending", position=1, printer_id=printer.id, manual_start=True)
    db_session.add(item)
    await db_session.commit()
    await db_session.refresh(item)
    return item


async def test_print_anyway_past_a_forced_colour_with_no_tray_is_refused(
    async_client: AsyncClient, db_session, printer_factory
):
    item = await _staged(db_session, printer_factory)
    with patch(BLOCKERS, AsyncMock(return_value=["PETG #DCDB4E"])):
        response = await async_client.post(f"/api/v1/queue/{item.id}/start?skip_filament_check=true")

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert (detail["code"], detail["missing"]) == ("forced_filament_missing", ["PETG #DCDB4E"])
    await db_session.refresh(item)
    assert (item.manual_start, item.skip_filament_check) == (True, False)


async def test_print_anyway_goes_ahead_when_nothing_is_in_the_way(
    async_client: AsyncClient, db_session, printer_factory
):
    item = await _staged(db_session, printer_factory)
    check = AsyncMock(return_value=[])
    with patch(BLOCKERS, check):
        response = await async_client.post(f"/api/v1/queue/{item.id}/start?skip_filament_check=true")

    assert response.status_code == 200, response.text
    assert response.json()["skip_filament_check"] is True
    check.assert_awaited_once()
    # A failing check never breaks Start: the scheduler holds the item again if need be.
    item = await _staged(db_session, printer_factory)
    with patch(BLOCKERS, AsyncMock(side_effect=RuntimeError("boom"))):
        response = await async_client.post(f"/api/v1/queue/{item.id}/start?skip_filament_check=true")
    assert response.status_code == 200
