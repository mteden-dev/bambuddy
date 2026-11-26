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
from backend.app.models.products import ProductJob, ProductOrder
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
        "prefer_margin_minutes": 30,
        "prefer_margin_pct": 25,
        "filament_swap_minutes": 10,
        "force_color": True,
        "hand_prints_count": False,
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


async def test_jobs_are_labelled_with_the_orders_they_print_for(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    first = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1, "notes": "first"}, connected)
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1, "notes": "second"}, connected)
    first_id = next(o["id"] for o in first["product"]["orders"] if o["notes"] == "first")
    tags = (await async_client.get("/api/v1/products/order-tags")).json()
    items = await _queue(db_session)
    labelled = {item.id: [t["label"] for t in tags["items"].get(str(item.id), {}).get("orders", [])] for item in items}
    # Every job prints for one of the two orders; each order gets a lid, a base and a tray.
    assert all(labels for labels in labelled.values())
    assert sorted(label for labels in labelled.values() for label in labels).count("first") >= 3
    assert {t["product_order_id"] for v in tags["items"].values() for t in v["orders"]} >= {first_id}
    assert not any(v["for_stock"] for v in tags["items"].values())

    # A job printing now labels its printer.
    item = items[0]
    item.status = "printing"
    item.printer_id = item.printer_id or (await db_session.get(QueueReservation, item.id)).printer_id
    await db_session.commit()
    online, status = _live(connected)
    with online, status:
        await async_client.get(f"/api/v1/products/{box.id}")
    tags = (await async_client.get("/api/v1/products/order-tags")).json()
    assert tags["printers"][str(item.printer_id)]["orders"][0]["label"] in ("first", "second")


# --- an order's print taken out of the queue ------------------------------------------------


async def test_a_print_stopped_part_way_is_replanned(async_client: AsyncClient, db_session, box):
    from backend.app.services import products

    products._auto_replans.clear()
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    item = (await _queue(db_session))[0]
    # Stop in the queue, or cancelled on the printer: the queue job ends cancelled after it started.
    item.status = "cancelled"
    item.started_at = item.created_at
    await db_session.commit()
    replans = []

    async def _record(product_id, actor_id, manual_start):
        replans.append(product_id)

    with patch.object(products, "_replan_later", side_effect=_record):
        await products.after_queue_items_changed(db_session, [item.id])
        await db_session.commit()
    assert replans == [box.id]
    job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == item.id))).scalar_one()
    assert job.status == "cancelled"
    products._auto_replans.clear()


async def test_a_waiting_job_cancelled_in_the_queue_is_not_replanned_by_itself(
    async_client: AsyncClient, db_session, box
):
    from backend.app.services import products

    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    item = (await _queue(db_session))[0]
    replans = []

    async def _record(product_id, actor_id, manual_start):
        replans.append(product_id)

    with patch.object(products, "_replan_later", side_effect=_record):
        response = await async_client.post(f"/api/v1/queue/{item.id}/cancel")
        assert response.status_code == 200, response.text
    assert replans == []


async def _cancel_job(client: AsyncClient, item_id: int, body: dict, connected: set[int]) -> dict:
    return await _post(client, f"/api/v1/products/queue-items/{item_id}/cancel", body, connected)


async def _detail(client: AsyncClient, product_id: int, connected: set[int]) -> dict:
    online, status = _live(connected)
    with online, status:
        response = await client.get(f"/api/v1/products/{product_id}")
    assert response.status_code == 200, response.text
    return response.json()


async def test_cancelling_an_order_print_to_print_it_again_puts_it_back(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray_id = next(i for i in await _queue(db_session) if i.printer_id is None).id
    result = await _cancel_job(async_client, tray_id, {"then": "replan"}, connected)
    assert result["replanned"] == [box.id]
    assert (result["created"], result["kept"]) == (1, 2)
    db_session.expire_all()
    status = await db_session.scalar(select(PrintQueueItem.status).where(PrintQueueItem.id == tray_id))
    assert status == "cancelled"
    trays = [i for i in await _queue(db_session) if i.library_file_id == box.files[("tray", 1)]]
    assert len(trays) == 1 and trays[0].id != tray_id
    assert (await _detail(async_client, box.id, connected))["unplanned"] == []


async def test_an_order_print_whose_pieces_are_on_hand_goes_to_stock(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    result = await _cancel_job(async_client, tray.id, {"then": "stock"}, connected)
    assert result["stocked"] == [{"part_id": box.parts["Tray"], "pieces": 1}]
    assert result["created"] == 0
    items = await _queue(db_session)
    assert len(items) == 2 and all(i.printer_id is not None for i in items)  # lid and base still print
    detail = await _detail(async_client, box.id, connected)
    assert detail["unplanned"] == []
    assert {(s["part_id"], s["printer_id"]): s["pieces"] for s in detail["stock"]} == {(box.parts["Tray"], 0): 1}


async def test_cancelling_an_order_print_can_withdraw_its_orders(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1, "notes": "first"}, connected)
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1, "notes": "second"}, connected)
    tags = (await async_client.get("/api/v1/products/order-tags")).json()["items"]
    tray_files = (box.files[("tray", 1)], box.files[("tray", 2)])
    tray = next(i for i in await _queue(db_session) if i.library_file_id in tray_files)
    served = [t["product_order_id"] for t in tags[str(tray.id)]["orders"]]
    assert served
    result = await _cancel_job(async_client, tray.id, {"then": "withdraw", "orders": served[:1]}, connected)
    assert result["withdrawn"] == served[:1]
    assert result["withdrawn_base_orders"] == []
    detail = await _detail(async_client, box.id, connected)
    open_ids = {o["id"] for o in detail["orders"] if o["status"] == "open"}
    assert served[0] not in open_ids and len(open_ids) == 1
    # The other order still gets everything it needs, and nothing more is queued for the withdrawn one.
    assert detail["unplanned"] == []
    trays = [i for i in await _queue(db_session) if i.library_file_id in tray_files]
    assert sum(2 if i.library_file_id == box.files[("tray", 2)] else 1 for i in trays) == 1


async def test_only_a_waiting_job_the_planner_made_is_cancelled_with_a_follow_up(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    by_hand = PrintQueueItem(library_file_id=box.files[("tray", 1)], status="pending", position=99)
    db_session.add(by_hand)
    await db_session.commit()
    response = await async_client.post(f"/api/v1/products/queue-items/{by_hand.id}/cancel", json={"then": "replan"})
    assert response.status_code == 409

    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    response = await async_client.post(f"/api/v1/products/queue-items/{tray.id}/cancel", json={"then": "withdraw"})
    assert response.status_code == 400
    tray.status = "printing"
    await db_session.commit()
    response = await async_client.post(f"/api/v1/products/queue-items/{tray.id}/cancel", json={"then": "replan"})
    assert response.status_code == 409


# --- stage 3: queue places, jobs moved by hand, plates printed by hand ----------------------


async def _positions(db_session) -> dict[int, int]:
    db_session.expire_all()
    rows = await db_session.execute(
        select(PrintQueueItem.id, PrintQueueItem.position).where(PrintQueueItem.status == "pending")
    )
    return dict(rows.all())


def _queued_pieces(product: dict) -> dict[str, int]:
    """Part name -> pieces of the product's jobs in the queue."""
    names = {p["id"]: p["name"] for p in product["parts"]}
    counts: dict[str, int] = {}
    for job in product["jobs"]:
        for piece in job["pieces"]:
            counts[names[piece["part_id"]]] = counts.get(names[piece["part_id"]], 0) + piece["pieces"]
    return counts


async def _add_by_hand(db_session, library_file_id: int, position: int, printer_id: int | None = None) -> int:
    item = PrintQueueItem(library_file_id=library_file_id, printer_id=printer_id, status="pending", position=position)
    db_session.add(item)
    await db_session.commit()
    return item.id


async def _hand_prints_count(async_client: AsyncClient, on: bool = True) -> None:
    response = await async_client.put(
        "/api/v1/products/settings", json={"plate_cost_minutes": 15, "hand_prints_count": on}
    )
    assert response.status_code == 200, response.text
    assert response.json()["hand_prints_count"] is on


async def test_a_replan_keeps_waiting_jobs_where_they_are_in_the_queue(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1, "notes": "first"}, connected)
    first = await _positions(db_session)
    # Someone queues something else after them.
    other_file = await _file(db_session, "keychain", "P1S", 600)
    other = await _add_by_hand(db_session, other_file, max(first.values()) + 1)

    result = await _post(
        async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1, "notes": "second"}, connected
    )
    after = await _positions(db_session)
    kept = {item_id: pos for item_id, pos in first.items() if item_id in after}
    assert kept and len(kept) == result["kept"]
    # The first box's prints did not go behind the keychain.
    assert all(after[item_id] == pos < after[other] for item_id, pos in kept.items())
    # The second box's new prints, for an order with no date, go to the end.
    new = [item_id for item_id in after if item_id not in first and item_id != other]
    assert new and all(after[item_id] > after[other] for item_id in new)


async def test_new_jobs_go_before_another_products_jobs_due_later(
    async_client: AsyncClient, db_session, box, printer_factory
):
    from datetime import datetime, timedelta, timezone

    connected = {box.a, box.b}
    later_file = await _file(db_session, "magnet", "P1S", 1800)
    response = await async_client.post(
        "/api/v1/products/",
        json={
            "name": "Magnet",
            "parts": [{"name": "Magnet"}],
            "plates": [{"library_file_id": later_file, "pieces": [{"part": 0, "pieces": 1}]}],
        },
    )
    assert response.status_code == 200, response.text
    magnet = response.json()["id"]
    now = datetime.now(timezone.utc)
    await _post(
        async_client,
        f"/api/v1/products/{magnet}/orders",
        {"quantity": 1, "due_date": (now + timedelta(days=3)).isoformat()},
        connected,
    )
    [magnet_job] = (await _positions(db_session)).keys()

    await _post(
        async_client,
        f"/api/v1/products/{box.id}/orders",
        {"quantity": 1, "due_date": (now + timedelta(days=1)).isoformat()},
        connected,
    )
    positions = await _positions(db_session)
    box_jobs = [item_id for item_id in positions if item_id != magnet_job]
    assert len(box_jobs) == 3
    # The box ships first: its prints go before the magnet's.
    assert all(positions[item_id] < positions[magnet_job] for item_id in box_jobs)


async def test_an_any_job_moved_to_another_printer_on_the_timeline_stays_there(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    reservation = await db_session.get(QueueReservation, tray.id)
    moved_to = box.a if reservation.printer_id == box.b else box.b
    reservation.printer_id = moved_to  # the timeline's plan, applied
    tray_id = tray.id
    await db_session.commit()

    result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
    assert result["held"] == 1
    db_session.expire_all()
    assert (await db_session.get(QueueReservation, tray_id)).printer_id == moved_to
    assert tray_id in await _positions(db_session)
    # The plan may move the other plates around it, but prints nothing twice.
    assert _queued_pieces(result["product"]) == {"Lid": 1, "Base": 1, "Tray": 1}


async def test_a_matched_part_moved_by_hand_is_kept_and_still_pairs(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    items = await _queue(db_session)
    lid = next(i for i in items if i.library_file_id == box.files[("lid", 1)])
    lid_id = lid.id
    lid.printer_id = box.a if lid.printer_id == box.b else box.b  # moved to the other printer
    moved_to = lid.printer_id
    await db_session.commit()

    result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
    # Nothing printed twice: the moved lid pairs with a base from any printer.
    assert result["held"] == 1
    assert _queued_pieces(result["product"]) == {"Lid": 1, "Base": 1, "Tray": 1}
    db_session.expire_all()
    assert await db_session.scalar(select(PrintQueueItem.printer_id).where(PrintQueueItem.id == lid_id)) == moved_to


async def test_a_job_moved_by_hand_leaves_when_its_order_is_cancelled(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    [order] = [o for o in result["product"]["orders"] if o["status"] == "open"]
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    reservation = await db_session.get(QueueReservation, tray.id)
    reservation.printer_id = box.a if reservation.printer_id == box.b else box.b
    await db_session.commit()
    await _post(async_client, f"/api/v1/products/orders/{order['id']}/cancel", None, connected)
    assert await _positions(db_session) == {}


async def test_a_plate_printed_by_hand_counts_and_is_not_printed_twice(async_client: AsyncClient, db_session, box):
    from backend.app.services import products

    connected = {box.a, box.b}
    await _hand_prints_count(async_client)
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    response = await async_client.delete(f"/api/v1/queue/{tray.id}")
    assert response.status_code == 200, response.text
    # Printed again from the library, by hand.
    by_hand = await _add_by_hand(db_session, box.files[("tray", 1)], 50)

    result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
    assert (result["created"], result["held"]) == (0, 1)
    job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == by_hand))).scalar_one()
    assert job.by_hand is True
    assert (await _detail(async_client, box.id, connected))["unplanned"] == []

    # It finishes: the tray is the order's.
    db_session.expire_all()
    item = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == by_hand))).scalar_one()
    item.status = "completed"
    item.printer_id = box.b
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [by_hand])
    await db_session.commit()
    detail = await _detail(async_client, box.id, connected)
    [order] = [o for o in detail["orders"] if o["status"] == "open"]
    tray_part = next(p for p in order["parts"] if p["part_id"] == box.parts["Tray"])
    assert tray_part["ready"] == tray_part["needed"] == 1


async def test_a_plate_printed_by_hand_is_linked_when_it_finishes(async_client: AsyncClient, db_session, box):
    from backend.app.services import products

    connected = {box.a, box.b}
    await _hand_prints_count(async_client)
    # Nobody ordered anything yet; a lid printed from the library goes to stock.
    item_id = await _add_by_hand(db_session, box.files[("lid", 2)], 1, printer_id=box.a)
    item = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()
    item.status = "completed"
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [item_id])
    await db_session.commit()
    detail = await _detail(async_client, box.id, connected)
    assert {(s["part_id"], s["printer_id"]): s["pieces"] for s in detail["stock"]} == {(box.parts["Lid"], box.a): 2}


# --- plates printed by hand that do not count (the default) ---------------------------------


async def _finish(db_session, item_id: int, printer_id: int) -> None:
    from backend.app.services import products

    db_session.expire_all()
    item = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()
    item.status = "completed"
    item.printer_id = printer_id
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [item_id])
    await db_session.commit()


def _stock(detail: dict) -> dict[tuple[int, int], int]:
    return {(s["part_id"], s["printer_id"]): s["pieces"] for s in detail["stock"]}


async def test_by_default_a_plate_printed_by_hand_is_shown_but_counts_for_nothing(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    settings = (await async_client.get("/api/v1/products/settings")).json()
    assert settings["hand_prints_count"] is False

    # A whole box printed from the library, beside the plan: nobody knows where it went.
    hand = [
        await _add_by_hand(db_session, box.files[(part, 1)], position, printer_id=box.a)
        for position, part in enumerate(("lid", "base", "tray"), start=1)
    ]
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    # Waiting in the queue, it is kept as it is, but the order prints in full beside it.
    assert result["held"] == 3
    assert result["created"] == 3
    jobs = {j["queue_item_id"]: j for j in result["product"]["jobs"]}
    assert all(jobs[item_id]["by_hand"] and not jobs[item_id]["counted"] for item_id in hand)
    assert all(j["counted"] for item_id, j in jobs.items() if item_id not in hand)
    assert _queued_pieces(result["product"]) == {"Lid": 2, "Base": 2, "Tray": 2}
    # It prints for no order: no label in the queue.
    tags = (await async_client.get("/api/v1/products/order-tags")).json()["items"]
    assert not any(str(item_id) in tags for item_id in hand)

    # Finished, it goes to no stock and closes no order.
    for item_id in hand:
        await _finish(db_session, item_id, box.a)
    detail = await _detail(async_client, box.id, connected)
    assert _stock(detail) == {}
    [order] = [o for o in detail["orders"] if o["status"] == "open"]
    assert order["units_ready"] == 0

    # Another order later on prints in full too.
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    assert _queued_pieces(result["product"]) == {"Lid": 2, "Base": 2, "Tray": 2}
    assert result["product"]["unplanned"] == []


async def test_hand_prints_that_stop_counting_take_stock_to_zero_at_most(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _hand_prints_count(async_client)
    # Counted: a box printed by hand closes an order, two more lids go to stock.
    hand = [
        await _add_by_hand(db_session, box.files[(part, n)], position, printer_id=box.a)
        for position, (part, n) in enumerate((("lid", 1), ("base", 1), ("tray", 1), ("lid", 2)), start=1)
    ]
    for item_id in hand:
        await _finish(db_session, item_id, box.a)
    result = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    assert result["planned_jobs"] == 0
    [order] = result["product"]["orders"]
    assert order["status"] == "done"
    assert _stock(await _detail(async_client, box.id, connected)) == {(box.parts["Lid"], box.a): 2}

    # They stop counting (as the jobs linked before the setting did): the lids
    # left are theirs, the box the order took is not taken back.
    await db_session.execute(ProductJob.__table__.update().where(ProductJob.by_hand.is_(True)).values(counted=False))
    await db_session.commit()
    detail = await _detail(async_client, box.id, connected)
    assert _stock(detail) == {}
    assert [o["status"] for o in detail["orders"]] == ["done"]


async def test_hand_prints_count_only_from_when_the_setting_is_on(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    before = await _add_by_hand(db_session, box.files[("tray", 1)], 1, printer_id=box.a)
    await _finish(db_session, before, box.a)
    await _hand_prints_count(async_client)
    after = await _add_by_hand(db_session, box.files[("tray", 2)], 2, printer_id=box.a)
    await _finish(db_session, after, box.a)
    # Only the two trays printed with the setting on are in stock.
    assert _stock(await _detail(async_client, box.id, connected)) == {(box.parts["Tray"], box.a): 2}
    counted = dict((await db_session.execute(select(ProductJob.queue_item_id, ProductJob.counted))).all())
    assert counted == {before: False, after: True}


async def test_the_product_says_which_jobs_were_queued_or_moved_by_hand(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    reservation = await db_session.get(QueueReservation, tray.id)
    moved_to = box.a if reservation.printer_id == box.b else box.b
    reservation.printer_id = moved_to
    tray_id = tray.id
    await db_session.commit()
    detail = await _detail(async_client, box.id, connected)
    [job] = [j for j in detail["jobs"] if j["queue_item_id"] == tray_id]
    assert (job["moved"], job["by_hand"], job["printer_id"]) == (True, False, moved_to)
    assert not any(j["moved"] for j in detail["jobs"] if j["queue_item_id"] != tray_id)


async def test_a_job_moved_by_hand_stays_moved_at_the_next_plan_too(async_client: AsyncClient, db_session, box):
    connected = {box.a, box.b}
    await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    tray = next(i for i in await _queue(db_session) if i.printer_id is None)
    tray_id = tray.id
    job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == tray_id))).scalar_one()
    job.planned_printer_id = None  # a job from before the plan's printer was kept
    reservation = await db_session.get(QueueReservation, tray_id)
    moved_to = box.a if reservation.printer_id == box.b else box.b
    reservation.printer_id = moved_to
    await db_session.commit()
    for _ in range(2):
        result = await _post(async_client, f"/api/v1/products/{box.id}/replan", None, connected)
        assert result["held"] == 1
    db_session.expire_all()
    assert (await db_session.get(QueueReservation, tray_id)).printer_id == moved_to


# --- a plate printed by hand, found bad, printed again ------------------------------------


async def _hand_printed(db_session, box, *, printer_id: int | None, target_model: str | None = None) -> int:
    """Two lids printed by hand from the library, finished and linked; returns the queue job."""
    from backend.app.services import products

    item = PrintQueueItem(
        library_file_id=box.files[("lid", 2)],
        printer_id=printer_id,
        target_model=target_model,
        status="pending",
        position=1,
        ams_mapping="[2, -1]",
        timelapse=True,
    )
    db_session.add(item)
    await db_session.commit()
    await products.link_hand_jobs(db_session, item_ids=[item.id])
    item.status = "completed"
    item.printer_id = item.printer_id or box.b
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [item.id])
    await db_session.commit()
    return item.id


async def test_bad_pieces_of_a_plate_printed_by_hand_can_be_printed_again_first_or_last(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    original = await _hand_printed(db_session, box, printer_id=box.a)
    keychain = await _file(db_session, "keychain", "P1S", 600)
    others = [await _add_by_hand(db_session, keychain, position) for position in (5, 6)]
    [job] = (await async_client.get("/api/v1/products/qc")).json()
    assert job["by_hand"] is True and job["reprint"] is None
    lid = {"rejected": [{"part_id": box.parts["Lid"], "pieces": 1}]}

    # Nobody ordered lids: without asking, nothing prints them again.
    result = await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", lid, connected)
    assert result["reprint_item_id"] is None
    assert [i.id for i in await _queue(db_session)] == others

    # As soon as possible: the plate goes first, to the printer it printed on, as it was set up.
    result = await _post(
        async_client, f"/api/v1/products/jobs/{job['id']}/check", {**lid, "reprint": "asap"}, connected
    )
    reprint_id = result["reprint_item_id"]
    assert result["job"]["reprint"] == "waiting"
    queue = await _queue(db_session)
    assert [i.id for i in queue] == [reprint_id, *others]
    first = queue[0]
    assert (first.library_file_id, first.printer_id, first.ams_mapping, first.timelapse) == (
        box.files[("lid", 2)],
        box.a,
        "[2, -1]",
        True,
    )
    assert first.archive_id is None and first.id != original
    reprint = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == reprint_id))).scalar_one()
    assert (reprint.by_hand, reprint.reprint_of_id, reprint.pieces) == (True, job["id"], {str(box.parts["Lid"]): 2})

    # Checked again while it waits: no second one.
    result = await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", {**lid, "reprint": "end"}, connected)
    assert result["reprint_item_id"] is None
    assert len(await _queue(db_session)) == 3
    checked = (await async_client.get("/api/v1/products/qc?checked=true")).json()
    assert [(j["id"], j["reprint"]) for j in checked] == [(job["id"], "waiting")]

    # Undo: the check is taken back and the plate leaves the queue.
    result = await _post(async_client, f"/api/v1/products/jobs/{job['id']}/uncheck", None, connected)
    assert result["replanned"] is True
    assert [i.id for i in await _queue(db_session)] == others

    # At the end of the queue.
    result = await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", {**lid, "reprint": "end"}, connected)
    assert [i.id for i in await _queue(db_session)] == [*others, result["reprint_item_id"]]

    # All good after all: the plate that has not started leaves the queue.
    await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", {}, connected)
    assert [i.id for i in await _queue(db_session)] == others


async def test_a_plate_printed_again_goes_where_it_went_or_to_the_printer_that_printed_it(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    lid = {"rejected": [{"part_id": box.parts["Lid"], "pieces": 2}], "reprint": "asap"}

    # Queued for any P1S: so is the reprint, without the slots of the printer that took it.
    original = await _hand_printed(db_session, box, printer_id=None, target_model="P1S")
    [job] = (await async_client.get("/api/v1/products/qc")).json()
    await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", lid, connected)
    [reprint] = await _queue(db_session)
    assert (reprint.printer_id, reprint.target_model, reprint.ams_mapping) == (None, "P1S", None)

    # Its queue job is gone from the history: the plate goes to the printer that printed it.
    await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", {}, connected)
    db_session.expire_all()
    await db_session.delete(await db_session.get(PrintQueueItem, original))
    await db_session.commit()
    await _post(async_client, f"/api/v1/products/jobs/{job['id']}/check", lid, connected)
    [reprint] = await _queue(db_session)
    assert (reprint.printer_id, reprint.target_model, reprint.library_file_id) == (box.b, None, box.files[("lid", 2)])
    assert reprint.ams_mapping is None


async def test_replanning_the_whole_queue_keeps_what_fits_and_drops_what_no_order_needs(
    async_client: AsyncClient, db_session, box
):
    connected = {box.a, box.b}
    assert (await _post(async_client, "/api/v1/products/replan", None, connected))["products"] == 0
    order = await _post(async_client, f"/api/v1/products/{box.id}/orders", {"quantity": 1}, connected)
    assert order["planned_jobs"] == 3

    result = await _post(async_client, "/api/v1/products/replan", None, connected)
    assert (result["products"], result["kept"], result["created"], result["replaced"]) == (1, 3, 0, 0)
    assert len(await _queue(db_session)) == 3

    # The order goes (cancelled in Base, say): its waiting jobs leave with the replan.
    row = (await db_session.execute(select(ProductOrder).where(ProductOrder.product_id == box.id))).scalar_one()
    row.status = "cancelled"
    await db_session.commit()
    result = await _post(async_client, "/api/v1/products/replan", None, connected)
    assert (result["products"], result["replaced"], result["failed"]) == (1, 3, [])
    assert await _queue(db_session) == []
