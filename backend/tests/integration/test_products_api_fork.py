"""Products API: orders become queue jobs, a second order replans, prints fill orders (fork).

See services/products.py and services/product_planner.py.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob
from backend.app.models.queue_reservations import QueueReservation

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600


def _live(connected: set[int]):
    from backend.app.services.printer_manager import printer_manager

    idle = SimpleNamespace(state="IDLE", remaining_time=0, progress=0)
    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=lambda pid: idle),
    )


async def _file(db_session, name: str, model: str, seconds: int, objects: int = 1) -> int:
    f = LibraryFile(
        filename=f"{name}.gcode.3mf",
        file_path=f"/test/{name}.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={
            "sliced_for_model": model,
            "print_time_seconds": seconds,
            "printable_objects": {str(i): name for i in range(1, objects + 1)},
        },
    )
    db_session.add(f)
    await db_session.commit()
    return f.id


@pytest.fixture
async def box(async_client: AsyncClient, db_session, printer_factory):
    """Two P1S printers and a box: lid and base (matched) and a tray, plates of 1 and 2."""
    a = await printer_factory(name="P1S-A", model="P1S")
    b = await printer_factory(name="P1S-B", model="P1S")
    files = {}
    for part, single, double in (("lid", 2 * H, 3.6 * H), ("base", 2 * H, 3.6 * H), ("tray", 1 * H, 1.8 * H)):
        files[(part, 1)] = await _file(db_session, f"{part}_x1", "P1S", single)
        files[(part, 2)] = await _file(db_session, f"{part}_x2", "P1S", int(double), objects=2)
    index = {"lid": 0, "base": 1, "tray": 2}
    body = {
        "name": "Box",
        "parts": [
            {"name": "Lid", "quantity": 1, "matched": True},
            {"name": "Base", "quantity": 1, "matched": True},
            {"name": "Tray", "quantity": 1, "matched": False},
        ],
        "plates": [
            {"library_file_id": file_id, "pieces": [{"part": index[part], "pieces": n}]}
            for (part, n), file_id in files.items()
        ],
    }
    response = await async_client.post("/api/v1/products/", json=body)
    assert response.status_code == 200, response.text
    product = response.json()
    parts = {p["name"]: p["id"] for p in product["parts"]}
    return SimpleNamespace(id=product["id"], a=a.id, b=b.id, parts=parts, files=files, product=product)


async def _post(client: AsyncClient, url: str, body: dict | None, connected: set[int]):
    online, status = _live(connected)
    with online, status:
        response = await client.post(url, json=body or {})
    assert response.status_code == 200, response.text
    return response.json()


async def _queue(db_session) -> list[PrintQueueItem]:
    db_session.expire_all()
    rows = await db_session.execute(
        select(PrintQueueItem).where(PrintQueueItem.status == "pending").order_by(PrintQueueItem.position)
    )
    return list(rows.scalars())


async def test_a_product_lists_its_parts_and_plates(async_client: AsyncClient, box):
    response = await async_client.get("/api/v1/products/")
    assert response.status_code == 200
    [listed] = response.json()
    assert listed["name"] == "Box"
    assert [p["name"] for p in listed["parts"]] == ["Lid", "Base", "Tray"]
    assert len(listed["plates"]) == 6
    lid_x2 = next(p for p in listed["plates"] if p["library_file_id"] == box.files[("lid", 2)])
    assert lid_x2["file"]["model"] == "P1S"
    assert lid_x2["file"]["object_count"] == 2


async def test_an_order_queues_lid_and_base_on_one_printer_and_the_tray_on_the_other(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    assert result["planned_jobs"] == 3
    items = await _queue(db_session)
    pinned = [i for i in items if i.printer_id is not None]
    assert {i.library_file_id for i in pinned} == {box.files[("lid", 1)], box.files[("base", 1)]}
    assert len({i.printer_id for i in pinned}) == 1
    [tray] = [i for i in items if i.printer_id is None]
    assert tray.library_file_id == box.files[("tray", 1)]
    assert tray.target_model == "P1S"
    reservation = await db_session.get(QueueReservation, tray.id)
    assert reservation is not None and reservation.printer_id != pinned[0].printer_id

    [order] = [o for o in result["product"]["orders"] if o["status"] == "open"]
    assert order["units_ready"] == 0
    assert result["product"]["unplanned"] == []
    # Times go out as UTC with one Z, as the rest of the API writes them.
    assert order["estimated_ready_at"].endswith("Z") and "+" not in order["estimated_ready_at"]
    assert result["finish_at"].endswith("Z") and "+" not in result["finish_at"]


async def test_a_second_order_replaces_the_waiting_jobs(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    assert result["replaced"] == 3
    # Only the new plan's jobs are queued (SQLite may hand the old ids out again).
    items = await _queue(db_session)
    assert len(items) == result["planned_jobs"]
    # Each box's lid and base still come from one printer.
    lids = [i for i in items if i.library_file_id in (box.files[("lid", 1)], box.files[("lid", 2)])]
    bases = [i for i in items if i.library_file_id in (box.files[("base", 1)], box.files[("base", 2)])]
    assert sorted(i.printer_id for i in lids) == sorted(i.printer_id for i in bases)
    jobs = list((await db_session.execute(select(ProductJob))).scalars())
    assert {j.queue_item_id for j in jobs} == {i.id for i in items}


async def test_finished_prints_fill_the_order_and_leave_stock(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    for item in await _queue(db_session):
        item.status = "completed"
        item.printer_id = item.printer_id or (await db_session.get(QueueReservation, item.id)).printer_id
    await db_session.commit()

    online, status = _live(connected)
    with online, status:
        response = await async_client.get(f"/api/v1/products/{box.id}")
    assert response.status_code == 200, response.text
    detail = response.json()
    [order] = detail["orders"]
    assert order["status"] == "done"
    # The pieces went to the order: nothing is left in stock.
    assert detail["stock"] == []
    assert detail["jobs"] == []


async def test_a_failed_print_is_replanned_on_the_same_printer(async_client: AsyncClient, db_session, box):
    from backend.app.services import products

    products._auto_replans.clear()
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    items = await _queue(db_session)
    lid = next(i for i in items if i.library_file_id == box.files[("lid", 1)])
    base = next(i for i in items if i.library_file_id == box.files[("base", 1)])
    printer = lid.printer_id
    lid.status = "completed"
    base.status = "failed"
    base.started_at = base.created_at
    await db_session.commit()

    replans = []

    async def _record(product_id, actor_id, manual_start):
        replans.append(product_id)

    with patch.object(products, "_replan_later", side_effect=_record):
        await products.after_queue_items_changed(db_session, [lid.id, base.id])
        await db_session.commit()
        import asyncio

        await asyncio.sleep(0)
    assert replans == [box.id]

    result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
    items = await _queue(db_session)
    new_base = [i for i in items if i.library_file_id == box.files[("base", 1)]]
    # The lid printed on that printer waits for its base from the same one.
    assert [i.printer_id for i in new_base] == [printer]
    assert not any(i.library_file_id in (box.files[("lid", 1)], box.files[("lid", 2)]) for i in items)
    stock = {(s["part_id"], s["printer_id"]): s["pieces"] for s in result["product"]["stock"]}
    assert stock == {(box.parts["Lid"], printer): 1}


async def test_a_print_the_printer_never_started_is_not_replanned(async_client: AsyncClient, db_session, box):
    from backend.app.services import products

    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    item = (await _queue(db_session))[0]
    # The scheduler gave up after its retries: failed, never started.
    item.status = "failed"
    item.started_at = None
    await db_session.commit()
    replans = []

    async def _record(product_id, actor_id, manual_start):
        replans.append(product_id)

    with patch.object(products, "_replan_later", side_effect=_record):
        await products.after_queue_items_changed(db_session, [item.id])
        await db_session.commit()
    assert replans == []
    job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == item.id))).scalar_one()
    assert job.status == "failed"


async def test_auto_replans_stop_when_prints_keep_failing():
    from backend.app.services import products

    products._auto_replans.clear()
    assert [products._may_auto_replan(99, 100.0 + i) for i in range(4)] == [True, True, True, False]
    # An hour later it may again.
    assert products._may_auto_replan(99, 100.0 + products.AUTO_REPLAN_WINDOW_S + 5)
    products._auto_replans.clear()


async def test_an_order_is_planned_while_every_printer_is_off(async_client: AsyncClient, db_session, box):
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected=set())
    assert result["planned_jobs"] == 3
    assert result["short"] == []


async def test_cancelling_the_order_takes_its_jobs_out_of_the_queue(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 2}, connected)
    [order] = [o for o in result["product"]["orders"] if o["status"] == "open"]
    result = await _post(async_client, f"/api/v1/products/orders/{order['id']}/cancel", None, connected)
    assert result["planned_jobs"] == 0
    assert await _queue(db_session) == []


async def test_a_deleted_queue_job_shows_as_unplanned(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    response = await async_client.delete(f"/api/v1/queue/{tray.id}")
    assert response.status_code == 200, response.text
    online, status = _live(connected)
    with online, status:
        detail = (await async_client.get(f"/api/v1/products/{box.id}")).json()
    assert detail["unplanned"] == [{"part_id": box.parts["Tray"], "pieces": 1}]


async def test_a_stock_correction_replans(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    # Two trays found on the shelf: the order needs none printed.
    await _post(
        async_client,
        f"/api/v1/products/{box.id}/stock",
        {"part_id": box.parts["Tray"], "delta": 2, "note": "found"},
        connected,
    )
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 2}, connected)
    items = await _queue(db_session)
    assert not any(i.library_file_id in (box.files[("tray", 1)], box.files[("tray", 2)]) for i in items)
    assert result["short"] == []


async def test_a_product_with_open_orders_cannot_be_deleted(async_client: AsyncClient, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    response = await async_client.delete(f"/api/v1/products/{box.id}")
    assert response.status_code == 409


async def test_a_file_without_a_model_is_refused(async_client: AsyncClient, db_session):
    f = LibraryFile(filename="raw.gcode", file_path="/test/raw.gcode", file_size=1, file_type="gcode")
    db_session.add(f)
    await db_session.commit()
    response = await async_client.post(
        "/api/v1/products/",
        json={
            "name": "Thing",
            "parts": [{"name": "Part"}],
            "plates": [{"library_file_id": f.id, "pieces": [{"part": 0, "pieces": 1}]}],
        },
    )
    assert response.status_code == 400


async def test_the_plate_cost_setting_round_trips(async_client: AsyncClient):
    assert (await async_client.get("/api/v1/products/settings")).json() == {"plate_cost_minutes": 15}
    response = await async_client.put("/api/v1/products/settings", json={"plate_cost_minutes": 40})
    assert response.json() == {"plate_cost_minutes": 40}
