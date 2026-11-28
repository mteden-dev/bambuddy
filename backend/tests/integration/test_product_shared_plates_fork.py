"""Shared plates: one plate printing parts of several products, planned together (fork).

Magazine holders are products of their own (single, double), sold apart, but a
plate may print both: the plate is shared, a print of it counts for each, and
the products sharing it are planned as one family. See services/products.py
("shared plates and families") and services/product_planner.py.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob, ProductJobProduct, ProductPlate

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600


def _live(connected: set[int]):
    from backend.app.services.printer_manager import printer_manager

    idle = SimpleNamespace(state="IDLE", remaining_time=0, progress=0)
    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=lambda pid: idle),
    )


async def _file(db_session, name: str, seconds: int) -> int:
    f = LibraryFile(
        filename=f"{name}.gcode.3mf",
        file_path=f"/test/{name}.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={"sliced_for_model": "P1S", "print_time_seconds": seconds},
    )
    db_session.add(f)
    await db_session.commit()
    return f.id


async def _call(client: AsyncClient, method: str, url: str, body: dict | None, connected: set[int], status=200):
    online, live = _live(connected)
    with online, live:
        response = await client.request(method, url, json=body)
    assert response.status_code == status, response.text
    return response.json()


async def _queue(db_session) -> list[PrintQueueItem]:
    db_session.expire_all()
    rows = await db_session.execute(
        select(PrintQueueItem).where(PrintQueueItem.status == "pending").order_by(PrintQueueItem.position)
    )
    return list(rows.scalars())


async def _finish(db_session, item_id: int, printer_id: int) -> None:
    from backend.app.services import products

    db_session.expire_all()
    item = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()
    item.status = "completed"
    item.printer_id = printer_id
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [item_id])
    await db_session.commit()


@pytest.fixture
async def holders(async_client: AsyncClient, db_session, printer_factory):
    """One P1S; a single and a double magazine holder, each with a plate of its own and a mixed plate of both."""
    printer = await printer_factory(name="P1S-A", model="P1S")
    files = {
        "single": await _file(db_session, "single_x2", 3 * H),
        "double": await _file(db_session, "double_x2", 3 * H),
        "mix": await _file(db_session, "mix_2_2", int(3.5 * H)),
    }
    connected = {printer.id}
    double = await _call(
        async_client,
        "POST",
        "/api/v1/products/",
        {
            "name": "Double",
            "parts": [{"name": "Holder"}],
            "plates": [{"library_file_id": files["double"], "pieces": [{"part": 0, "pieces": 2}]}],
        },
        connected,
    )
    double_part = double["parts"][0]["id"]
    single = await _call(
        async_client,
        "POST",
        "/api/v1/products/",
        {
            "name": "Single",
            "parts": [{"name": "Holder"}],
            "plates": [
                {"library_file_id": files["single"], "pieces": [{"part": 0, "pieces": 2}]},
                {
                    "library_file_id": files["mix"],
                    "pieces": [{"part": 0, "pieces": 2}],
                    "others": [{"part_id": double_part, "pieces": 2}],
                },
            ],
        },
        connected,
    )
    return SimpleNamespace(
        printer=printer.id,
        connected=connected,
        files=files,
        single=single["id"],
        single_part=single["parts"][0]["id"],
        double=double["id"],
        double_part=double_part,
    )


def _plate(detail: dict, file_id: int) -> dict:
    return next(p for p in detail["plates"] if p["library_file_id"] == file_id)


async def test_a_mixed_plate_shows_on_every_product_it_prints_for(async_client: AsyncClient, holders):
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)

    mix = _plate(single, holders.files["mix"])
    assert mix["pieces"] == [{"part_id": holders.single_part, "pieces": 2}]
    assert [(o["part_id"], o["pieces"], o["product_name"]) for o in mix["others"]] == [
        (holders.double_part, 2, "Double")
    ]
    assert mix["holder_product_id"] is None

    shared = _plate(double, holders.files["mix"])
    assert shared["id"] == mix["id"]  # one plate, not a copy per product
    assert shared["pieces"] == [{"part_id": holders.double_part, "pieces": 2}]
    assert [(o["part_id"], o["product_name"]) for o in shared["others"]] == [(holders.single_part, "Single")]
    assert shared["holder_product_id"] == holders.single


async def test_orders_of_both_products_print_once_on_the_mixed_plate(async_client: AsyncClient, db_session, holders):
    await _call(async_client, "POST", f"/api/v1/products/{holders.single}/orders", {"quantity": 2}, holders.connected)
    result = await _call(
        async_client, "POST", f"/api/v1/products/{holders.double}/orders", {"quantity": 2}, holders.connected
    )
    assert result["short"] == []

    [item] = await _queue(db_session)
    assert item.library_file_id == holders.files["mix"]
    job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == item.id))).scalar_one()
    assert job.product_id == holders.single
    links = (
        await db_session.execute(select(ProductJobProduct.product_id).where(ProductJobProduct.job_id == job.id))
    ).scalars()
    assert list(links) == [holders.double]

    # The job is labelled with the orders of both products.
    tags = (await async_client.get("/api/v1/products/order-tags")).json()
    served = {t["product_order_id"] for t in tags["items"][str(item.id)]["orders"]}
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    assert served == {single["orders"][0]["id"], double["orders"][0]["id"]}
    # Each product sees the job, with its own pieces, and nothing left unplanned.
    assert [j["pieces"] for j in double["jobs"]] == [[{"part_id": holders.double_part, "pieces": 2}]]
    assert single["unplanned"] == [] and double["unplanned"] == []


async def test_a_finished_mixed_plate_fills_both_products_orders(async_client: AsyncClient, db_session, holders):
    await _call(async_client, "POST", f"/api/v1/products/{holders.single}/orders", {"quantity": 2}, holders.connected)
    await _call(async_client, "POST", f"/api/v1/products/{holders.double}/orders", {"quantity": 1}, holders.connected)
    [item] = await _queue(db_session)
    assert item.library_file_id == holders.files["mix"]
    await _finish(db_session, item.id, holders.printer)

    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    assert [o["status"] for o in single["orders"]] == ["done"]
    assert [o["status"] for o in double["orders"]] == ["done"]
    # The second double holder went to the shelf, of the printer that printed it.
    assert single["stock"] == []
    assert [(s["part_id"], s["printer_id"], s["pieces"]) for s in double["stock"]] == [
        (holders.double_part, holders.printer, 1)
    ]


async def test_saving_the_holding_product_keeps_the_other_products_pieces(async_client: AsyncClient, holders):
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    # A client that knows nothing of shared plates sends the pieces of its own parts only.
    body = {
        "name": "Single holder",
        "parts": [{"id": holders.single_part, "name": "Holder"}],
        "plates": [
            {"library_file_id": p["library_file_id"], "pieces": [{"part": 0, "pieces": p["pieces"][0]["pieces"]}]}
            for p in single["plates"]
        ],
    }
    await _call(async_client, "PUT", f"/api/v1/products/{holders.single}", body, holders.connected)
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    assert _plate(double, holders.files["mix"])["pieces"] == [{"part_id": holders.double_part, "pieces": 2}]

    # Sent, they are set exactly: three double holders on it now.
    body["plates"][1]["others"] = [{"part_id": holders.double_part, "pieces": 3}]
    await _call(async_client, "PUT", f"/api/v1/products/{holders.single}", body, holders.connected)
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    assert _plate(double, holders.files["mix"])["pieces"] == [{"part_id": holders.double_part, "pieces": 3}]


async def test_a_plate_left_out_by_the_other_product_takes_only_its_pieces_off(
    async_client: AsyncClient, db_session, holders
):
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    body = {
        "name": "Double",
        "parts": [{"id": holders.double_part, "name": "Holder"}],
        "plates": [{"library_file_id": holders.files["double"], "pieces": [{"part": 0, "pieces": 2}]}],
    }
    assert len(double["plates"]) == 2
    await _call(async_client, "PUT", f"/api/v1/products/{holders.double}", body, holders.connected)
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    mix = _plate(single, holders.files["mix"])
    assert mix["pieces"] == [{"part_id": holders.single_part, "pieces": 2}] and mix["others"] == []
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    assert [p["library_file_id"] for p in double["plates"]] == [holders.files["double"]]


async def test_taking_the_plate_off_its_holder_passes_it_to_the_other_product(
    async_client: AsyncClient, db_session, holders
):
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    mix_id = _plate(single, holders.files["mix"])["id"]
    await _call(async_client, "DELETE", f"/api/v1/products/{holders.single}/plates/{mix_id}", None, holders.connected)
    plate = await db_session.get(ProductPlate, mix_id)
    await db_session.refresh(plate)
    assert plate.product_id == holders.double
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    mix = _plate(double, holders.files["mix"])
    assert mix["holder_product_id"] is None and mix["others"] == []
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    assert holders.files["mix"] not in [p["library_file_id"] for p in single["plates"]]


async def test_deleting_the_holding_product_keeps_the_others_plate_and_stock(
    async_client: AsyncClient, db_session, holders
):
    await _call(async_client, "POST", f"/api/v1/products/{holders.single}/orders", {"quantity": 2}, holders.connected)
    await _call(async_client, "POST", f"/api/v1/products/{holders.double}/orders", {"quantity": 1}, holders.connected)
    [item] = await _queue(db_session)
    await _finish(db_session, item.id, holders.printer)

    await _call(async_client, "DELETE", f"/api/v1/products/{holders.single}", None, holders.connected)
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    # The spare double holder the mixed plate made is still on the shelf.
    assert [(s["part_id"], s["pieces"]) for s in double["stock"]] == [(holders.double_part, 1)]
    mix = _plate(double, holders.files["mix"])
    assert mix["holder_product_id"] is None
    assert mix["pieces"] == [{"part_id": holders.double_part, "pieces": 2}] and mix["others"] == []


async def test_a_plate_another_product_has_for_the_file_is_joined_not_copied(
    async_client: AsyncClient, db_session, holders
):
    # The single holder adds the double's own file, with the double's pieces on it too.
    await _call(
        async_client,
        "POST",
        f"/api/v1/products/{holders.single}/plates",
        {
            "plates": [
                {
                    "library_file_id": holders.files["double"],
                    "pieces": [{"part_name": "Holder", "pieces": 1}, {"part_id": holders.double_part, "pieces": 2}],
                }
            ]
        },
        holders.connected,
    )
    rows = (
        await db_session.execute(select(ProductPlate).where(ProductPlate.library_file_id == holders.files["double"]))
    ).scalars()
    [plate] = list(rows)
    assert plate.product_id == holders.double
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    joined = _plate(single, holders.files["double"])
    assert joined["holder_product_id"] == holders.double
    assert joined["pieces"] == [{"part_id": holders.single_part, "pieces": 1}]


async def test_products_with_matched_parts_cannot_share_a_plate(async_client: AsyncClient, db_session, holders):
    lid = await _file(db_session, "lid_base", 2 * H)
    box = await _call(
        async_client,
        "POST",
        "/api/v1/products/",
        {
            "name": "Box",
            "parts": [{"name": "Lid", "matched": True}, {"name": "Base", "matched": True}],
            "plates": [{"library_file_id": lid, "pieces": [{"part": 0, "pieces": 1}, {"part": 1, "pieces": 1}]}],
        },
        holders.connected,
    )
    response = await async_client.post(
        f"/api/v1/products/{holders.single}/plates",
        json={
            "plates": [
                {
                    "library_file_id": lid,
                    "pieces": [{"part_name": "Holder", "pieces": 1}, {"part_id": box["parts"][0]["id"], "pieces": 1}],
                }
            ]
        },
    )
    assert response.status_code == 400
    assert "matched" in response.json()["detail"]

    # A product sharing a plate cannot mark a part matched either.
    response = await async_client.put(
        f"/api/v1/products/{holders.double}",
        json={
            "name": "Double",
            "parts": [{"id": holders.double_part, "name": "Holder", "matched": True}],
            "plates": [{"library_file_id": holders.files["double"], "pieces": [{"part": 0, "pieces": 2}]}],
        },
    )
    # The double still has the mixed plate: it is the single's, so leaving it out
    # only takes the double's pieces off, and then nothing is shared any more.
    assert response.status_code == 200, response.text
    response = await async_client.put(
        f"/api/v1/products/{holders.single}",
        json={
            "name": "Single",
            "parts": [{"id": holders.single_part, "name": "Holder", "matched": True}],
            "plates": [
                {
                    "library_file_id": holders.files["mix"],
                    "pieces": [{"part": 0, "pieces": 2}],
                    "others": [{"part_id": holders.double_part, "pieces": 2}],
                }
            ],
        },
    )
    assert response.status_code == 400
    assert "matched" in response.json()["detail"]


async def test_a_bad_piece_of_the_other_product_reopens_its_order(async_client: AsyncClient, db_session, holders):
    await _call(async_client, "POST", f"/api/v1/products/{holders.single}/orders", {"quantity": 2}, holders.connected)
    await _call(async_client, "POST", f"/api/v1/products/{holders.double}/orders", {"quantity": 2}, holders.connected)
    [item] = await _queue(db_session)
    await _finish(db_session, item.id, holders.printer)

    [job] = (await async_client.get("/api/v1/products/qc")).json()
    # Named by product: both parts are called "Holder".
    assert sorted((p["part_name"], p["pieces"]) for p in job["pieces"]) == [("Double", 2), ("Single", 2)]
    assert job["product_name"] == "Single + Double"

    checked = await _call(
        async_client,
        "POST",
        f"/api/v1/products/jobs/{job['id']}/check",
        {"rejected": [{"part_id": holders.double_part, "pieces": 1}]},
        holders.connected,
    )
    double = await _call(async_client, "GET", f"/api/v1/products/{holders.double}", None, holders.connected)
    assert checked["reopened_orders"] == [double["orders"][0]["id"]]
    assert double["orders"][0]["status"] == "open"
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    assert single["orders"][0]["status"] == "done"
    # A new double holder is queued for it.
    assert [i.library_file_id for i in await _queue(db_session)] in (
        [holders.files["double"]],
        [holders.files["mix"]],
    )


async def test_a_third_product_joining_the_mixed_plate_keeps_what_else_it_prints(
    async_client: AsyncClient, db_session, holders
):
    triple = await _call(
        async_client, "POST", "/api/v1/products/", {"name": "Triple", "parts": [{"name": "Holder"}]}, holders.connected
    )
    # The triple names only the double (not the single holding the plate): the plate is
    # still found through the double's part on it, and the single's pieces stay.
    await _call(
        async_client,
        "POST",
        f"/api/v1/products/{triple['id']}/plates",
        {
            "plates": [
                {
                    "library_file_id": holders.files["mix"],
                    "pieces": [{"part_name": "Holder", "pieces": 1}, {"part_id": holders.double_part, "pieces": 2}],
                }
            ]
        },
        holders.connected,
    )
    rows = (
        await db_session.execute(select(ProductPlate).where(ProductPlate.library_file_id == holders.files["mix"]))
    ).scalars()
    [plate] = list(rows)
    assert plate.product_id == holders.single
    single = await _call(async_client, "GET", f"/api/v1/products/{holders.single}", None, holders.connected)
    mix = _plate(single, holders.files["mix"])
    assert mix["pieces"] == [{"part_id": holders.single_part, "pieces": 2}]
    assert sorted((o["product_name"], o["pieces"]) for o in mix["others"]) == [("Double", 2), ("Triple", 1)]


async def test_saving_a_new_plate_naming_another_product_joins_its_plate(async_client: AsyncClient, holders):
    triple = await _call(
        async_client,
        "POST",
        "/api/v1/products/",
        {
            "name": "Triple",
            "parts": [{"name": "Holder"}],
            "plates": [
                {
                    "library_file_id": holders.files["mix"],
                    "pieces": [{"part": 0, "pieces": 1}],
                    "others": [{"part_id": holders.double_part, "pieces": 2}],
                }
            ],
        },
        holders.connected,
    )
    [mix] = triple["plates"]
    assert mix["holder_product_id"] == holders.single
    assert sorted((o["product_name"], o["pieces"]) for o in mix["others"]) == [("Double", 2), ("Single", 2)]
