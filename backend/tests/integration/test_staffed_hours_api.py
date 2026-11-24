"""Staffed hours in the queue forecast and GET/PUT /queue/staffed-hours (fork)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def _live(connected: set[int], printing: dict[int, int]):
    def status(printer_id: int):
        if printer_id in printing:
            return SimpleNamespace(state="RUNNING", remaining_time=printing[printer_id], progress=50)
        return SimpleNamespace(state="IDLE", remaining_time=0, progress=0)

    from backend.app.services.printer_manager import printer_manager

    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=status),
    )


def _hours(opens: datetime, closes: datetime, clear: int = 5) -> dict:
    day = {"start": opens.strftime("%H:%M"), "end": closes.strftime("%H:%M")}
    return {"enabled": True, "timezone": "UTC", "days": [day] * 7, "clear_minutes": clear}


async def test_staffed_hours_round_trip(async_client: AsyncClient):
    body = {
        "enabled": True,
        "timezone": "Europe/Warsaw",
        "days": [{"start": "07:00", "end": "22:00"}] * 5 + [{"start": "09:00", "end": "14:00"}, None],
        "clear_minutes": 5,
    }

    response = await async_client.put("/api/v1/queue/staffed-hours", json=body)

    assert response.status_code == 200, response.text
    stored = (await async_client.get("/api/v1/queue/staffed-hours")).json()
    learned = stored.pop("learned")
    assert stored == {**body, "learn": True, "marks": []}
    # Nothing to learn from yet.
    assert learned == {"samples": 0, "needed": 10, "typical_minutes": None}


async def test_a_null_counts_as_not_sent(async_client: AsyncClient):
    week = [{"start": "07:00", "end": "22:00"}] * 6 + [None]
    body = {"enabled": None, "timezone": None, "days": week, "clear_minutes": None, "learn": None}

    response = await async_client.put("/api/v1/queue/staffed-hours", json=body)

    assert response.status_code == 200, response.text
    stored = response.json()
    assert (stored["enabled"], stored["timezone"], stored["clear_minutes"], stored["learn"]) == (False, "UTC", 0, True)
    # A day may still be null: nobody is there.
    assert stored["days"][6] is None
    assert (await async_client.put("/api/v1/queue/staffed-hours", json={"days": None})).status_code == 422


async def test_staffed_hours_are_checked(async_client: AsyncClient):
    week = [{"start": "07:00", "end": "22:00"}] * 7
    assert (await async_client.put("/api/v1/queue/staffed-hours", json={"days": week[:6]})).status_code == 422
    bad = [{"start": "7:00", "end": "22:00"}] + week[1:]
    assert (await async_client.put("/api/v1/queue/staffed-hours", json={"days": bad})).status_code == 422
    too_long = {"days": week, "clear_minutes": 999}
    assert (await async_client.put("/api/v1/queue/staffed-hours", json=too_long)).status_code == 422


def _stamp(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M")


async def test_marks_round_trip_and_stay_when_not_sent(async_client: AsyncClient):
    now = datetime.now(timezone.utc)
    week = [{"start": "07:00", "end": "22:00"}] * 7
    away = {"start": _stamp(now + timedelta(hours=1)), "end": _stamp(now + timedelta(hours=9)), "kind": "away"}
    here = {"start": _stamp(now + timedelta(days=3)), "end": _stamp(now + timedelta(days=3, hours=4)), "kind": "here"}
    old = {"start": _stamp(now - timedelta(days=5)), "end": _stamp(now - timedelta(days=4)), "kind": "away"}

    response = await async_client.put("/api/v1/queue/staffed-hours", json={"days": week, "marks": [here, away, old]})

    assert response.status_code == 200, response.text
    # In order, without the one that ended days ago.
    assert response.json()["marks"] == [away, here]
    # Saving the weekly hours alone keeps them; an empty list clears them.
    await async_client.put("/api/v1/queue/staffed-hours", json={"days": week, "clear_minutes": 3})
    assert (await async_client.get("/api/v1/queue/staffed-hours")).json()["marks"] == [away, here]
    cleared = await async_client.put("/api/v1/queue/staffed-hours", json={"days": week, "marks": []})
    assert cleared.json()["marks"] == []


async def test_marks_are_checked(async_client: AsyncClient):
    week = [{"start": "07:00", "end": "22:00"}] * 7
    for mark in (
        {"start": "2026-11-24T08:00", "end": "2026-11-24T07:00"},
        {"start": "2026-11-24 00:00", "end": "2026-11-24T07:00"},
        {"start": "2026-02-30T00:00", "end": "2026-03-01T07:00"},
        {"start": "2026-11-24T00:00", "end": "2027-01-24T07:00"},
        {"start": "2026-11-24T00:00", "end": "2026-11-24T07:00", "kind": "maybe"},
    ):
        response = await async_client.put("/api/v1/queue/staffed-hours", json={"days": week, "marks": [mark]})
        assert response.status_code == 422, mark


async def test_a_print_ending_in_a_marked_absence_waits_until_it_is_over(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    printer_id = printer.id
    archive_id = (await archive_factory(printer_id, sliced_for_model="P1S")).id
    item = PrintQueueItem(
        archive_id=archive_id, status="pending", position=1, print_time_seconds=3600, target_model="P1S"
    )
    db_session.add_all([item, Settings(key="require_plate_clear", value="true")])
    await db_session.commit()
    item_id = item.id
    # No weekly hours: only marked away from now for three hours; the print ends in half an hour.
    now = datetime.now(timezone.utc)
    back = (now + timedelta(hours=3)).replace(second=0, microsecond=0)
    away = {"start": _stamp(now - timedelta(minutes=5)), "end": _stamp(back), "kind": "away"}
    body = {"enabled": False, "timezone": "UTC", "days": [None] * 7, "clear_minutes": 5, "marks": [away]}
    assert (await async_client.put("/api/v1/queue/staffed-hours", json=body)).status_code == 200

    connected, status = _live({printer_id}, printing={printer_id: 30})
    with connected, status:
        body = (await async_client.get("/api/v1/queue/forecast")).json()

    [placement] = [p for p in body["placements"] if p["item_id"] == item_id]
    assert abs(datetime.fromisoformat(placement["start"]) - (back + timedelta(minutes=5))) < timedelta(minutes=1)
    [wait] = [w for w in body["plate_waits"] if w["printer_id"] == printer_id and w["end"] == placement["start"]]
    assert wait["reason"] == "absent"
    assert body["staffed"]["enabled"] is False
    assert [m["kind"] for m in body["staffed"]["marks"]] == ["away"]
    assert datetime.fromisoformat(body["staffed"]["marks"][0]["end"]) == back
    assert body["staffed"]["someone_there_reason"] == "absent"


async def test_the_next_job_waits_for_someone_to_clear_the_plate(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    printer_id = printer.id
    archive_id = (await archive_factory(printer_id, sliced_for_model="P1S")).id
    item = PrintQueueItem(
        archive_id=archive_id, status="pending", position=1, print_time_seconds=3600, target_model="P1S"
    )
    db_session.add_all([item, Settings(key="require_plate_clear", value="true")])
    await db_session.commit()
    item_id = item.id
    # Nobody is there for the next two hours; the print ends in half an hour.
    now = datetime.now(timezone.utc)
    opens = (now + timedelta(hours=2)).replace(second=0, microsecond=0)
    assert (
        await async_client.put("/api/v1/queue/staffed-hours", json=_hours(opens, opens + timedelta(hours=3)))
    ).status_code == 200

    connected, status = _live({printer_id}, printing={printer_id: 30})
    with connected, status:
        body = (await async_client.get("/api/v1/queue/forecast")).json()

    [placement] = [p for p in body["placements"] if p["item_id"] == item_id]
    start = datetime.fromisoformat(placement["start"])
    assert abs(start - (opens + timedelta(minutes=5))) < timedelta(minutes=1)
    [wait] = [w for w in body["plate_waits"] if w["printer_id"] == printer_id and w["end"] == placement["start"]]
    assert abs(datetime.fromisoformat(wait["start"]) - (now + timedelta(minutes=30))) < timedelta(minutes=1)
    assert body["staffed"]["waits_for_plate"] is True
    assert body["staffed"]["enabled"] is True
    assert body["staffed"]["windows"]


async def test_without_plate_clear_confirmation_nothing_waits(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    printer_id = printer.id
    archive_id = (await archive_factory(printer_id, sliced_for_model="P1S")).id
    item = PrintQueueItem(
        archive_id=archive_id, status="pending", position=1, print_time_seconds=3600, target_model="P1S"
    )
    db_session.add(item)
    await db_session.commit()
    now = datetime.now(timezone.utc)
    opens = (now + timedelta(hours=2)).replace(second=0, microsecond=0)
    await async_client.put("/api/v1/queue/staffed-hours", json=_hours(opens, opens + timedelta(hours=3)))

    connected, status = _live({printer_id}, printing={printer_id: 30})
    with connected, status:
        body = (await async_client.get("/api/v1/queue/forecast")).json()

    [placement] = body["placements"]
    assert abs(datetime.fromisoformat(placement["start"]) - (now + timedelta(minutes=30))) < timedelta(minutes=1)
    assert body["plate_waits"] == []
    assert body["staffed"]["waits_for_plate"] is False


async def test_a_job_waiting_for_a_manual_start_waits_for_the_staffed_hours(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    printer_id = printer.id
    archive_id = (await archive_factory(printer_id, sliced_for_model="P1S")).id
    staged = PrintQueueItem(
        archive_id=archive_id,
        status="pending",
        position=1,
        print_time_seconds=3600,
        target_model="P1S",
        manual_start=True,
    )
    after = PrintQueueItem(
        archive_id=archive_id, status="pending", position=2, print_time_seconds=3600, target_model="P1S"
    )
    db_session.add_all([staged, after])
    await db_session.commit()
    staged_id, after_id = staged.id, after.id
    # Nobody is there for the next two hours; plate-clear confirmation is off.
    now = datetime.now(timezone.utc)
    opens = (now + timedelta(hours=2)).replace(second=0, microsecond=0)
    assert (
        await async_client.put("/api/v1/queue/staffed-hours", json=_hours(opens, opens + timedelta(hours=3)))
    ).status_code == 200

    connected, status = _live({printer_id}, printing={})
    with connected, status:
        body = (await async_client.get("/api/v1/queue/forecast")).json()

    starts = {p["item_id"]: datetime.fromisoformat(p["start"]) for p in body["placements"]}
    # The automatic job behind it runs now; the staged one once someone can press Start.
    assert abs(starts[after_id] - now) < timedelta(minutes=1)
    assert starts[staged_id] == datetime.fromisoformat(body["staffed"]["someone_there_at"])
    assert abs(starts[staged_id] - opens) < timedelta(minutes=1)
    assert body["staffed"]["someone_there_reason"] == "unstaffed"
    assert body["off_timeline"] == []
