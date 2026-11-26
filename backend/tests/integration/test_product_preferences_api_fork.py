"""Products API: a preferred printer per plate, and the filament on the spools in the plan (fork).

See services/product_planner.py, services/product_filament.py and
PUT /products/jobs/{id}/preference.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob
from backend.app.models.queue_reservations import QueueReservation
from backend.app.services import product_filament
from backend.app.services.product_filament import PrinterSpools

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600
GREEN = {"slot_id": 1, "type": "PETG", "color": "#00AE42", "tray_info_idx": "", "used_grams": 100.0}


def _live(connected: set[int], busy: dict[int, int] | None = None):
    """Printers ``connected``, idle unless ``busy`` (printer id -> minutes left)."""
    from backend.app.services.printer_manager import printer_manager

    def status(pid: int):
        minutes = (busy or {}).get(pid)
        if minutes:
            return SimpleNamespace(state="RUNNING", remaining_time=minutes, progress=50)
        return SimpleNamespace(state="IDLE", remaining_time=0, progress=0)

    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=status),
    )


def _tray(kind: str, color: str) -> dict:
    return {
        "type": kind,
        "color": color,
        "color_known": True,
        "tray_info_idx": "",
        "ams_id": 0,
        "tray_id": 0,
        "is_ht": False,
        "is_external": False,
        "global_tray_id": 0,
        "extruder_id": None,
        "remain": -1,
    }


@pytest.fixture
async def trays(async_client: AsyncClient, db_session, printer_factory):
    """Two P1S printers and a product of one loose part (a tray) with a 2 h plate."""
    a = await printer_factory(name="P1S-A", model="P1S")
    b = await printer_factory(name="P1S-B", model="P1S")
    f = LibraryFile(
        filename="tray_x1.gcode.3mf",
        file_path="/test/tray_x1.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={"sliced_for_model": "P1S", "print_time_seconds": 2 * H, "printable_objects": {"1": "tray"}},
    )
    db_session.add(f)
    await db_session.commit()
    response = await async_client.post(
        "/api/v1/products/",
        json={
            "name": "Tray",
            "parts": [{"name": "Tray", "quantity": 1, "matched": False}],
            "plates": [{"library_file_id": f.id, "pieces": [{"part": 0, "pieces": 1}]}],
        },
    )
    assert response.status_code == 200, response.text
    return SimpleNamespace(id=response.json()["id"], a=a.id, b=b.id)


async def _call(client: AsyncClient, method: str, url: str, body: dict | None, connected: set[int], **kw):
    online, status = _live(connected, kw.get("busy"))
    with online, status:
        return await client.request(method, url, json=body or {})


async def _order(client: AsyncClient, trays, **kw) -> dict:
    response = await _call(
        client, "POST", f"/api/v1/products/{trays.id}/orders", {"quantity": 1}, {trays.a, trays.b}, **kw
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _jobs(db_session) -> list[ProductJob]:
    db_session.expire_all()
    rows = await db_session.execute(select(ProductJob).where(ProductJob.status == "planned").order_by(ProductJob.id))
    return list(rows.scalars())


async def _reserved(db_session, job: ProductJob) -> int | None:
    row = await db_session.get(QueueReservation, job.queue_item_id)
    return row.printer_id if row is not None else None


async def test_the_settings_keep_the_margin_the_swap_time_and_the_colours(async_client: AsyncClient):
    response = await async_client.get("/api/v1/products/settings")
    assert response.status_code == 200
    body = response.json()
    assert (body["prefer_margin_minutes"], body["prefer_margin_pct"], body["filament_swap_minutes"]) == (30, 25, 10)
    assert body["force_color"] is True

    response = await async_client.put(
        "/api/v1/products/settings",
        json={
            "plate_cost_minutes": 20,
            "prefer_margin_minutes": 45,
            "prefer_margin_pct": 10,
            "filament_swap_minutes": 5,
            "force_color": False,
        },
    )
    assert response.status_code == 200, response.text
    # Only the plate cost: the others stay.
    response = await async_client.put("/api/v1/products/settings", json={"plate_cost_minutes": 15})
    body = response.json()
    assert (body["plate_cost_minutes"], body["prefer_margin_minutes"], body["prefer_margin_pct"]) == (15, 45, 10)
    assert (body["filament_swap_minutes"], body["force_color"]) == (5, False)
    response = await async_client.put(
        "/api/v1/products/settings", json={"plate_cost_minutes": 15, "prefer_margin_pct": 101}
    )
    assert response.status_code == 422


async def test_a_preferred_printer_takes_the_plate_and_keeps_it_through_replans(
    async_client: AsyncClient, db_session, trays
):
    await _order(async_client, trays)
    [job] = await _jobs(db_session)
    first = await _reserved(db_session, job)
    other = trays.b if first == trays.a else trays.a

    response = await _call(
        async_client, "PUT", f"/api/v1/products/jobs/{job.id}/preference", {"printer_id": other}, {trays.a, trays.b}
    )
    assert response.status_code == 200, response.text
    [job] = await _jobs(db_session)
    assert job.preferred_printer_id == other
    assert await _reserved(db_session, job) == other

    response = await _call(async_client, "POST", f"/api/v1/products/{trays.id}/replan", None, {trays.a, trays.b})
    assert response.status_code == 200, response.text
    assert response.json()["kept"] == 1
    [job] = await _jobs(db_session)
    assert (job.preferred_printer_id, await _reserved(db_session, job)) == (other, other)

    # "Automatic" takes it back.
    response = await _call(
        async_client, "PUT", f"/api/v1/products/jobs/{job.id}/preference", {"printer_id": None}, {trays.a, trays.b}
    )
    assert response.status_code == 200, response.text
    [job] = await _jobs(db_session)
    assert job.preferred_printer_id is None


async def test_a_printer_done_much_sooner_wins_and_the_plate_says_why(async_client: AsyncClient, db_session, trays):
    busy = {trays.b: 5 * 60}
    await _order(async_client, trays, busy=busy)
    [job] = await _jobs(db_session)
    assert await _reserved(db_session, job) == trays.a

    response = await _call(
        async_client,
        "PUT",
        f"/api/v1/products/jobs/{job.id}/preference",
        {"printer_id": trays.b},
        {trays.a, trays.b},
        busy=busy,
    )
    assert response.status_code == 200, response.text
    [job] = await _jobs(db_session)
    assert await _reserved(db_session, job) == trays.a
    assert job.preferred_printer_id == trays.b
    assert job.plan_info["overruled"] == "earlier"
    assert job.plan_info["overruled_by_s"] >= 4 * H


async def test_a_preference_needs_an_enabled_printer_of_the_plates_model(
    async_client: AsyncClient, db_session, trays, printer_factory
):
    h2s = (await printer_factory(name="H2S", model="H2S")).id
    await _order(async_client, trays)
    [job] = await _jobs(db_session)
    for printer_id in (h2s, 999_999):
        response = await _call(
            async_client,
            "PUT",
            f"/api/v1/products/jobs/{job.id}/preference",
            {"printer_id": printer_id},
            {trays.a, trays.b},
        )
        assert response.status_code == 400, response.text


async def test_a_plate_moved_by_hand_takes_no_preference(async_client: AsyncClient, db_session, trays):
    await _order(async_client, trays)
    [job] = await _jobs(db_session)
    first = await _reserved(db_session, job)
    other = trays.b if first == trays.a else trays.a
    reservation = await db_session.get(QueueReservation, job.queue_item_id)
    reservation.printer_id = other
    await db_session.commit()
    response = await _call(
        async_client, "PUT", f"/api/v1/products/jobs/{job.id}/preference", {"printer_id": first}, {trays.a, trays.b}
    )
    assert response.status_code == 409, response.text


async def test_the_plan_puts_a_plate_where_its_filament_is_and_asks_for_the_colour(
    async_client: AsyncClient, db_session, trays, monkeypatch
):
    spools = {
        trays.a: PrinterSpools(loaded=[_tray("PETG", "#000000")], left={0: 900.0}),
        trays.b: PrinterSpools(loaded=[_tray("PETG", "#00AE42")], left={0: 500.0}),
    }

    async def load_spools(db, printer_ids):
        return {pid: spools[pid] for pid in printer_ids if pid in spools}

    monkeypatch.setattr(product_filament, "load_spools", load_spools)
    monkeypatch.setattr(product_filament, "requirements", lambda path, plate: [dict(GREEN)])

    await _order(async_client, trays)
    [job] = await _jobs(db_session)
    # Printer A would need the green spool loaded first.
    assert await _reserved(db_session, job) == trays.b
    [note] = job.plan_info["filament"]
    assert (note["type"], note["color"], note["left"], note["swap"]) == ("PETG", "#00ae42", 400.0, None)
    item = await db_session.get(PrintQueueItem, job.queue_item_id)
    [override] = json.loads(item.filament_overrides)
    assert override["force_color_match"] is True and override["color"] == "#00ae42"

    # Preferring A does not move it: A needs a spool loaded and B does not.
    response = await _call(
        async_client, "PUT", f"/api/v1/products/jobs/{job.id}/preference", {"printer_id": trays.a}, {trays.a, trays.b}
    )
    assert response.status_code == 200, response.text
    [job] = await _jobs(db_session)
    assert await _reserved(db_session, job) == trays.b
    assert (job.preferred_printer_id, job.plan_info["overruled"]) == (trays.a, "filament")


async def test_without_forcing_colours_the_queue_job_asks_for_none(
    async_client: AsyncClient, db_session, trays, monkeypatch
):
    monkeypatch.setattr(product_filament, "requirements", lambda path, plate: [dict(GREEN)])
    response = await async_client.put(
        "/api/v1/products/settings", json={"plate_cost_minutes": 15, "force_color": False}
    )
    assert response.status_code == 200
    await _order(async_client, trays)
    [job] = await _jobs(db_session)
    item = await db_session.get(PrintQueueItem, job.queue_item_id)
    assert item.filament_overrides is None
