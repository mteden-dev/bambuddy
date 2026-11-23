"""GET /queue/forecast places "Any <model>" jobs on printers for the timeline (fork)."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from backend.app.models.print_queue import PrintQueueItem

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _item(db_session, archive_id: int, position: int, **extra) -> int:
    item = PrintQueueItem(archive_id=archive_id, status="pending", position=position, print_time_seconds=3600, **extra)
    db_session.add(item)
    await db_session.commit()
    return item.id


def _live(connected: set[int], printing: dict[int, int] | None = None):
    """Patch the printers' live state: which are connected, and minutes left on those printing."""
    printing = printing or {}

    def status(printer_id: int):
        if printer_id in printing:
            return SimpleNamespace(state="RUNNING", remaining_time=printing[printer_id], progress=50)
        return SimpleNamespace(state="IDLE", remaining_time=0, progress=0)

    from backend.app.services.printer_manager import printer_manager

    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=status),
    )


async def test_any_jobs_are_spread_over_the_free_printers(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    a = await printer_factory(name="P1S-A", model="P1S")
    b = await printer_factory(name="P1S-B", model="P1S")
    h2d = await printer_factory(name="H2D", model="H2D")
    a_id, b_id, h2d_id = a.id, b.id, h2d.id
    archive_id = (await archive_factory(a_id, sliced_for_model="P1S")).id
    pinned = await _item(db_session, archive_id, 1, printer_id=a_id)
    any1 = await _item(db_session, archive_id, 2, target_model="P1S")
    any2 = await _item(db_session, archive_id, 3, target_model="P1S")
    staged = await _item(db_session, archive_id, 4, target_model="P1S", manual_start=True)
    held = await _item(db_session, archive_id, 5, target_model="P1S", waiting_reason="Waiting for filament: PETG")

    connected, status = _live({a_id, b_id, h2d_id}, printing={b_id: 30})
    with connected, status:
        response = await async_client.get("/api/v1/queue/forecast")

    assert response.status_code == 200, response.text
    body = response.json()
    placed = {p["item_id"]: (p["printer_id"], p["projected"]) for p in body["placements"]}
    # A is free now and takes the pinned job first; B frees up in 30 minutes and
    # takes the first "Any" job; the second waits for A to finish the pinned one.
    assert placed == {pinned: (a_id, False), any1: (b_id, True), any2: (a_id, True)}
    starts = {p["item_id"]: datetime.fromisoformat(p["start"]) for p in body["placements"]}
    assert starts[pinned] < starts[any1] < starts[any2]

    off = {o["item_id"]: (o["reason"], o["detail"]) for o in body["off_timeline"]}
    assert off == {staged: ("manual_start", None), held: ("waiting", "Waiting for filament: PETG")}

    lanes = {p["printer_id"]: p for p in body["printers"]}
    assert lanes[b_id]["external_print"] is True  # RUNNING with no queue job printing
    assert lanes[a_id]["external_print"] is False

    # A P1S file may not be dropped on the H2D, and the refusal says why.
    assert body["refusals"][str(any1)] == {str(h2d_id): {"code": "model", "detail": "P1S"}}


async def test_any_jobs_wait_off_the_lanes_when_no_printer_of_the_model_can_take_them(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    a = await printer_factory(name="P1S-A", model="P1S")
    a_id = a.id
    archive_id = (await archive_factory(a_id, sliced_for_model="P1S")).id
    job = await _item(db_session, archive_id, 1, target_model="P1S")

    connected, status = _live(set())
    with connected, status:
        response = await async_client.get("/api/v1/queue/forecast")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["placements"] == []
    assert body["off_timeline"] == [{"item_id": job, "reason": "no_printer", "detail": None}]


async def test_a_scheduled_job_starts_at_its_time(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    a = await printer_factory(name="P1S-A", model="P1S")
    a_id = a.id
    archive_id = (await archive_factory(a_id, sliced_for_model="P1S")).id
    at = datetime(2099, 1, 1, 8, 0)
    job = await _item(db_session, archive_id, 1, target_model="P1S", scheduled_time=at)

    connected, status = _live({a_id})
    with connected, status:
        response = await async_client.get("/api/v1/queue/forecast")

    assert response.status_code == 200, response.text
    [placement] = response.json()["placements"]
    assert placement["item_id"] == job
    assert datetime.fromisoformat(placement["start"]) == at.replace(tzinfo=timezone.utc)


async def test_a_pinned_job_waiting_for_its_plate_stays_on_its_lane(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    # The printer card's "Next in queue" names this job: the lane must too, not
    # only the "Any" jobs forecast onto the same printer.
    a = await printer_factory(name="P1S-A", model="P1S")
    a_id = a.id
    archive_id = (await archive_factory(a_id, sliced_for_model="P1S")).id
    pinned = await _item(
        db_session, archive_id, 1, printer_id=a_id, waiting_reason="Waiting for plate confirmation: P1S-A"
    )
    other = await _item(db_session, archive_id, 2, printer_id=a_id, waiting_reason="Waiting for filament: PETG")
    any_job = await _item(db_session, archive_id, 3, target_model="P1S")

    connected, status = _live({a_id})
    with connected, status:
        response = await async_client.get("/api/v1/queue/forecast")

    body = response.json()
    starts = {p["item_id"]: datetime.fromisoformat(p["start"]) for p in body["placements"]}
    assert set(starts) == {pinned, any_job}
    assert starts[pinned] < starts[any_job]
    assert body["off_timeline"] == [{"item_id": other, "reason": "waiting", "detail": "Waiting for filament: PETG"}]
