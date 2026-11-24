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
    # The job waiting for a manual start goes last: with no staffed hours,
    # someone may press Start any time, and B is free next.
    assert placed == {pinned: (a_id, False), any1: (b_id, True), any2: (a_id, True), staged: (b_id, True)}
    starts = {p["item_id"]: datetime.fromisoformat(p["start"]) for p in body["placements"]}
    assert starts[pinned] < starts[any1] < starts[any2] < starts[staged]

    off = {o["item_id"]: (o["reason"], o["detail"]) for o in body["off_timeline"]}
    assert off == {held: ("waiting", "Waiting for filament: PETG")}

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


async def test_a_job_with_alternatives_shows_the_file_its_printer_gets(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.models.library import LibraryFile
    from backend.app.models.print_queue import PrintQueueVariant

    p1s = await printer_factory(name="P1S", model="P1S")
    h2s = await printer_factory(name="BigBoy", model="H2S")
    p1s_id, h2s_id = p1s.id, h2s.id
    p1s_file = LibraryFile(
        filename="box_p1s.3mf",
        file_path="l/box_p1s.3mf",
        file_type="3mf",
        file_size=1,
        file_metadata={"print_name": "Box (P1S)"},
    )
    h2s_file = LibraryFile(
        filename="box_h2s.3mf",
        file_path="l/box_h2s.3mf",
        file_type="3mf",
        file_size=1,
        thumbnail_path="thumbs/box_h2s.png",
    )
    db_session.add_all([p1s_file, h2s_file])
    await db_session.flush()
    item = PrintQueueItem(status="pending", position=1, target_model="P1S", print_time_seconds=3600)
    db_session.add(item)
    await db_session.flush()
    db_session.add_all(
        [
            PrintQueueVariant(
                queue_item_id=item.id,
                library_file_id=p1s_file.id,
                target_model="P1S",
                position=0,
                print_time_seconds=3 * 3600,
            ),
            PrintQueueVariant(
                queue_item_id=item.id,
                library_file_id=h2s_file.id,
                target_model="H2S",
                position=1,
                print_time_seconds=2 * 3600,
                plate_id=2,
            ),
        ]
    )
    await db_session.commit()
    item_id, h2s_file_id = item.id, h2s_file.id

    # The P1S is busy for five hours, so the H2S takes the job, with its own file.
    connected, status = _live({p1s_id, h2s_id}, printing={p1s_id: 300})
    with connected, status:
        response = await async_client.get("/api/v1/queue/forecast")

    assert response.status_code == 200, response.text
    [placement] = [p for p in response.json()["placements"] if p["item_id"] == item_id]
    assert placement["printer_id"] == h2s_id
    assert placement["variant"] == {
        "library_file_id": h2s_file_id,
        "target_model": "H2S",
        "name": "box_h2s.3mf",
        "plate_id": 2,
        "has_thumbnail": True,
        "print_time_seconds": 7200,
    }
    start, end = datetime.fromisoformat(placement["start"]), datetime.fromisoformat(placement["end"])
    assert (end - start).total_seconds() == 7200
