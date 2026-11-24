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


async def test_a_second_order_keeps_the_first_boxs_jobs_and_adds_the_second(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    first = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    assert result["kept"] + result["created"] == result["planned_jobs"]
    assert result["kept"] + result["replaced"] == first["planned_jobs"]
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
    assert (await async_client.get("/api/v1/products/settings")).json()["plate_cost_minutes"] == 15
    response = await async_client.put("/api/v1/products/settings", json={"plate_cost_minutes": 40})
    assert response.json()["plate_cost_minutes"] == 40


# --- replans keep what still fits ---------------------------------------------------------


async def test_a_replan_keeps_waiting_jobs_that_still_fit_with_their_changes(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    items = await _queue(db_session)
    lid = next(i for i in items if i.library_file_id == box.files[("lid", 1)])
    lid.ams_mapping = "[2, -1]"  # changed by hand in the queue
    await db_session.commit()
    before = {(i.id, i.created_at) for i in items}

    result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
    assert (result["kept"], result["created"], result["replaced"]) == (3, 0, 0)
    items = await _queue(db_session)
    assert {(i.id, i.created_at) for i in items} == before
    assert next(i for i in items if i.id == lid.id).ams_mapping == "[2, -1]"


async def test_editing_the_product_keeps_its_plates_and_their_jobs(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    product = (await async_client.get(f"/api/v1/products/{box.id}")).json()
    plate_ids = {p["id"] for p in product["plates"]}
    body = {
        "name": "Box v2",
        "parts": [
            {"id": p["id"], "name": p["name"], "quantity": p["quantity"], "matched": p["matched"]}
            for p in product["parts"]
        ],
        "plates": [
            {
                "library_file_id": p["library_file_id"],
                "pieces": [
                    {
                        "part_name": next(x["name"] for x in product["parts"] if x["id"] == pp["part_id"]),
                        "pieces": pp["pieces"],
                    }
                    for pp in p["pieces"]
                ],
            }
            for p in product["plates"]
        ],
    }
    response = await async_client.put(f"/api/v1/products/{box.id}", json=body)
    assert response.status_code == 200, response.text
    assert {p["id"] for p in response.json()["plates"]} == plate_ids
    result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
    assert result["kept"] == 3 and result["replaced"] == 0


# --- finishing time ---------------------------------------------------------------------------


async def test_a_part_that_dries_after_printing_is_queued_before_the_lid(
    async_client: AsyncClient, db_session, printer_factory
):
    printer = await printer_factory(name="Only", model="P1S")
    lid = await _file(db_session, "lid_one", "P1S", 2 * H)
    base = await _file(db_session, "base_one", "P1S", 2 * H)
    body = {
        "name": "Box",
        "parts": [
            {"name": "Lid", "matched": True},
            {"name": "Base", "matched": True, "finish_minutes": 60},
        ],
        "plates": [
            {"library_file_id": lid, "pieces": [{"part_name": "lid", "pieces": 1}]},
            {"library_file_id": base, "pieces": [{"part_name": "Base", "pieces": 1}]},
        ],
    }
    created = (await async_client.post("/api/v1/products/", json=body)).json()
    assert [p["finish_minutes"] for p in created["parts"]] == [0, 60]
    await _post(async_client, f"/api/v1/products/{created['id']}/orders", {"quantity": 1}, {printer.id})
    assert [i.library_file_id for i in await _queue(db_session)] == [base, lid]


# --- plates by API ------------------------------------------------------------------------------


async def test_plates_are_added_by_part_name_and_taken_off(async_client: AsyncClient, db_session, box):
    extra = await _file(db_session, "lid_x3", "P1S", int(5 * H), objects=3)
    response = await async_client.post(
        f"/api/v1/products/{box.id}/plates",
        json={"plates": [{"library_file_id": extra, "pieces": [{"part_name": "LID", "pieces": 3}]}]},
    )
    assert response.status_code == 200, response.text
    plate = next(p for p in response.json()["plates"] if p["library_file_id"] == extra)
    assert plate["pieces"] == [{"part_id": box.parts["Lid"], "pieces": 3}]

    # The same file again replaces its pieces instead of adding a second plate.
    response = await async_client.post(
        f"/api/v1/products/{box.id}/plates",
        json={"plates": [{"library_file_id": extra, "pieces": [{"part_id": box.parts["Lid"], "pieces": 2}]}]},
    )
    plates = [p for p in response.json()["plates"] if p["library_file_id"] == extra]
    assert len(plates) == 1 and plates[0]["pieces"][0]["pieces"] == 2

    response = await async_client.delete(f"/api/v1/products/{box.id}/plates/{plate['id']}")
    assert response.status_code == 200
    assert all(p["library_file_id"] != extra for p in response.json()["plates"])

    response = await async_client.post(
        f"/api/v1/products/{box.id}/plates",
        json={"plates": [{"library_file_id": extra, "pieces": [{"part_name": "Handle", "pieces": 1}]}]},
    )
    assert response.status_code == 400


async def test_plates_are_suggested_from_a_folder_and_applied(async_client: AsyncClient, db_session):
    from backend.app.models.library import LibraryFolder

    root = LibraryFolder(name="9mm")
    db_session.add(root)
    await db_session.flush()
    sub = LibraryFolder(name="H2S", parent_id=root.id)
    db_session.add(sub)
    await db_session.commit()

    async def put(name, model, objects, folder):
        f = LibraryFile(
            filename=f"{name}.gcode.3mf",
            file_path=f"/test/{name}.gcode.3mf",
            file_size=1,
            file_type="3mf",
            folder_id=folder,
            file_metadata={
                "sliced_for_model": model,
                "print_time_seconds": 3600,
                "printable_objects": {str(i): name for i in range(objects)},
            },
        )
        db_session.add(f)
        await db_session.commit()
        return f.id

    lid2 = await put("9mm_gora_x2", "P1S", 2, root.id)
    combo = await put("9mm_top_dol", "H2S", 2, sub.id)
    unknown = await put("plate_7", "P1S", 1, root.id)
    created = (
        await async_client.post(
            "/api/v1/products/",
            json={"name": "9mm", "parts": [{"name": "Góra", "matched": True}, {"name": "Dół", "matched": True}]},
        )
    ).json()
    parts = {p["name"]: p["id"] for p in created["parts"]}

    response = await async_client.post(
        f"/api/v1/products/{created['id']}/plates/suggest",
        json={"folder_id": root.id, "keywords": {"Góra": ["top"]}},
    )
    assert response.status_code == 200, response.text
    by_file = {s["file"]["library_file_id"]: s for s in response.json()["suggestions"]}
    assert set(by_file) == {lid2, combo, unknown}
    assert by_file[lid2]["pieces"] == [{"part_id": parts["Góra"], "pieces": 2}]
    assert sorted((p["part_id"], p["pieces"]) for p in by_file[combo]["pieces"]) == [
        (parts["Góra"], 1),
        (parts["Dół"], 1),
    ]
    assert by_file[unknown]["pieces"] == [] and by_file[unknown]["found_by"] is None

    response = await async_client.post(
        f"/api/v1/products/{created['id']}/plates/suggest",
        json={"folder_id": root.id, "keywords": {"Góra": ["top"]}, "apply": True},
    )
    assert response.json()["applied"] == 2
    product = (await async_client.get(f"/api/v1/products/{created['id']}")).json()
    assert {p["library_file_id"] for p in product["plates"]} == {lid2, combo}


# --- thumbnail ---------------------------------------------------------------------------------


def _png(color=(200, 30, 30), size=(800, 400)) -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format="PNG")
    return out.getvalue()


async def test_a_picture_is_uploaded_served_and_removed(async_client: AsyncClient, box, tmp_path, monkeypatch):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    assert (await async_client.get(f"/api/v1/products/{box.id}/thumbnail")).status_code == 404

    response = await async_client.post(
        f"/api/v1/products/{box.id}/thumbnail", files={"file": ("box.png", _png(), "image/png")}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["has_thumbnail"] and body["custom_thumbnail"] and body["thumbnail_version"]

    picture = await async_client.get(f"/api/v1/products/{box.id}/thumbnail")
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/png"
    import io

    from PIL import Image

    assert max(Image.open(io.BytesIO(picture.content)).size) == 512

    stored = list((tmp_path / "products" / "thumbnails").iterdir())
    assert len(stored) == 1
    response = await async_client.delete(f"/api/v1/products/{box.id}/thumbnail")
    assert response.json()["custom_thumbnail"] is False
    assert list((tmp_path / "products" / "thumbnails").iterdir()) == []


async def test_a_non_image_is_refused(async_client: AsyncClient, box, tmp_path, monkeypatch):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    response = await async_client.post(
        f"/api/v1/products/{box.id}/thumbnail", files={"file": ("x.png", b"not an image", "image/png")}
    )
    assert response.status_code == 400


async def test_the_picture_falls_back_to_a_plate_and_can_come_from_a_library_file(
    async_client: AsyncClient, db_session, box, tmp_path, monkeypatch
):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    (tmp_path / "thumbs").mkdir()
    (tmp_path / "thumbs" / "lid.png").write_bytes(_png((0, 200, 0), (64, 64)))
    lid = await db_session.get(LibraryFile, box.files[("lid", 1)])
    lid.thumbnail_path = "thumbs/lid.png"
    await db_session.commit()

    detail = (await async_client.get(f"/api/v1/products/{box.id}")).json()
    assert detail["has_thumbnail"] and not detail["custom_thumbnail"]
    assert (await async_client.get(f"/api/v1/products/{box.id}/thumbnail")).status_code == 200

    response = await async_client.post(f"/api/v1/products/{box.id}/thumbnail/from-file/{lid.id}")
    assert response.status_code == 200, response.text
    assert response.json()["custom_thumbnail"] is True


# --- moving pieces ---------------------------------------------------------------------------------


async def test_moving_a_base_to_the_lids_printer_completes_the_box(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    for part, printer in (("Lid", box.a), ("Base", box.b), ("Tray", box.b)):
        await _post(
            async_client,
            f"/api/v1/products/{box.id}/stock",
            {"part_id": box.parts[part], "printer_id": printer, "delta": 1},
            connected,
        )
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    # Lid on A and base on B do not pair: the plan prints the missing ones.
    assert result["planned_jobs"] > 0

    result = await _post(
        async_client,
        f"/api/v1/products/{box.id}/stock/move",
        {"part_id": box.parts["Base"], "from_printer_id": box.b, "to_printer_id": box.a, "pieces": 1},
        connected,
    )
    assert result["planned_jobs"] == 0
    [order] = result["product"]["orders"]
    assert order["status"] == "done"

    online, status = _live(connected)
    with online, status:
        response = await async_client.post(
            f"/api/v1/products/{box.id}/stock/move",
            json={"part_id": box.parts["Lid"], "from_printer_id": box.b, "to_printer_id": box.a, "pieces": 5},
        )
    assert response.status_code == 400


async def test_the_settings_say_when_shortest_first_is_on(async_client: AsyncClient, db_session):
    from backend.app.models.settings import Settings

    db_session.add(Settings(key="queue_shortest_first", value="true"))
    await db_session.commit()
    assert (await async_client.get("/api/v1/products/settings")).json() == {
        "plate_cost_minutes": 15,
        "sjf_enabled": True,
    }


async def test_finished_jobs_wait_to_be_checked_and_a_bad_piece_reopens_the_order(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    for item in await _queue(db_session):
        item.status = "completed"
        item.printer_id = item.printer_id or (await db_session.get(QueueReservation, item.id)).printer_id
    await db_session.commit()
    online, status = _live(connected)
    with online, status:
        detail = (await async_client.get(f"/api/v1/products/{box.id}")).json()
    [order] = detail["orders"]
    assert order["status"] == "done"  # unchecked pieces count as good

    to_check = (await async_client.get("/api/v1/products/qc")).json()
    assert sorted(j["pieces"][0]["part_name"] for j in to_check) == ["Base", "Lid", "Tray"]
    by_part = {j["pieces"][0]["part_name"]: j for j in to_check}
    lid_printer = by_part["Lid"]["printer_id"]
    on_lid_printer = (await async_client.get(f"/api/v1/products/qc?printer_id={lid_printer}")).json()
    assert sorted(j["pieces"][0]["part_name"] for j in on_lid_printer) == ["Base", "Lid"]

    # The tray is fine: nothing changes.
    checked = await _post(async_client, f"/api/v1/products/jobs/{by_part['Tray']['id']}/check", {}, connected)
    assert checked["replanned"] is False and checked["job"]["checked_at"] is not None

    # The lid is cracked: the order opens again and a new lid goes on the base's printer.
    checked = await _post(
        async_client,
        f"/api/v1/products/jobs/{by_part['Lid']['id']}/check",
        {"rejected": [{"part_id": box.parts["Lid"], "pieces": 1}]},
        connected,
    )
    assert checked["replanned"] is True
    assert checked["reopened_orders"] == [order["id"]]
    assert checked["job"]["pieces"][0]["rejected"] == 1
    [lid] = await _queue(db_session)
    assert lid.library_file_id == box.files[("lid", 1)] and lid.printer_id == lid_printer

    left = (await async_client.get("/api/v1/products/qc")).json()
    assert [j["pieces"][0]["part_name"] for j in left] == ["Base"]
    # A part the job did not print is refused.
    response = await async_client.post(
        f"/api/v1/products/jobs/{by_part['Base']['id']}/check",
        json={"rejected": [{"part_id": box.parts["Tray"], "pieces": 1}]},
    )
    assert response.status_code == 400


async def _finished_box(async_client: AsyncClient, db_session, box) -> dict[str, dict]:
    """One box ordered and printed; its jobs to check by part name."""
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    for item in await _queue(db_session):
        item.status = "completed"
        item.printer_id = item.printer_id or (await db_session.get(QueueReservation, item.id)).printer_id
    await db_session.commit()
    online, status = _live(connected)
    with online, status:
        await async_client.get(f"/api/v1/products/{box.id}")
    return {j["pieces"][0]["part_name"]: j for j in (await async_client.get("/api/v1/products/qc")).json()}


async def test_the_question_at_plate_clear_is_about_the_plate_on_the_printer_only(
    async_client: AsyncClient, db_session, box
):
    from datetime import datetime, timedelta, timezone

    from backend.app.models.plate_clears import PlateClear

    jobs = await _finished_box(async_client, db_session, box)
    printer = jobs["Lid"]["printer_id"]
    # Lid and base were printed on one printer: only the newest is on its plate.
    [on_plate] = (await async_client.get(f"/api/v1/products/qc?printer_id={printer}&on_plate=true")).json()
    newest = max((j for j in jobs.values() if j["printer_id"] == printer), key=lambda j: (j["finished_at"], j["id"]))
    assert on_plate["id"] == newest["id"]

    # The plate was cleared after both finished ("check later"): nothing is on it now.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db_session.add(PlateClear(printer_id=printer, finished_at=now, cleared_at=now + timedelta(minutes=1)))
    await db_session.commit()
    assert (await async_client.get(f"/api/v1/products/qc?printer_id={printer}&on_plate=true")).json() == []
    # They still wait in the list.
    assert len((await async_client.get(f"/api/v1/products/qc?printer_id={printer}")).json()) == 2


async def test_a_check_can_be_taken_back_and_goes_to_the_archive(
    async_client: AsyncClient, db_session, box, archive_factory
):
    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_log import PrintLogEntry

    connected = {box.a, box.b}
    jobs = await _finished_box(async_client, db_session, box)
    lid = jobs["Lid"]
    job = await db_session.get(ProductJob, lid["id"])
    archive = await archive_factory(lid["printer_id"])
    run = (await db_session.execute(select(PrintLogEntry).where(PrintLogEntry.archive_id == archive.id))).scalar_one()
    run.queue_item_id = job.queue_item_id
    job.archive_id = archive.id
    run_id, archive_id = run.id, archive.id
    await db_session.commit()

    # Its only piece is bad: the print is a reject in the archive.
    await _post(
        async_client,
        f"/api/v1/products/jobs/{lid['id']}/check",
        {"rejected": [{"part_id": box.parts["Lid"], "pieces": 1}], "source": "plate_clear"},
        connected,
    )
    db_session.expire_all()
    run = await db_session.get(PrintLogEntry, run_id)
    assert (run.user_verdict, run.user_verdict_source) == ("reject", "plate_clear")
    assert (await db_session.get(PrintArchive, archive_id)).user_verdict == "reject"
    checked = (await async_client.get("/api/v1/products/qc?checked=true")).json()
    assert [(j["id"], j["pieces"][0]["rejected"]) for j in checked] == [(lid["id"], 1)]

    # Undo: it waits again, the verdict is gone and the extra lid is no longer planned.
    result = await _post(async_client, f"/api/v1/products/jobs/{lid['id']}/uncheck", None, connected)
    assert result["replanned"] is True and result["job"]["checked_at"] is None
    db_session.expire_all()
    assert (await db_session.get(PrintLogEntry, run_id)).user_verdict is None
    assert await _queue(db_session) == []
    assert lid["id"] in [j["id"] for j in (await async_client.get("/api/v1/products/qc")).json()]

    # All good: a good print.
    await _post(async_client, f"/api/v1/products/jobs/{lid['id']}/check", {}, connected)
    db_session.expire_all()
    assert (await db_session.get(PrintLogEntry, run_id)).user_verdict == "good"
