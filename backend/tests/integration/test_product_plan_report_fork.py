"""What the products API tells the pages about a plan (fork).

Base orders are changed on the Orders page; the plan's own times; products
planned again behind a more urgent one; the websocket message after a plan;
the plan settings; why an order has no estimate. See services/products.py.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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


async def _product(
    client: AsyncClient, db_session, name: str, seconds: int, parts: int = 1, model: str = "P1S"
) -> SimpleNamespace:
    """A product of ``parts`` parts, each printed one piece per plate; with two, they are matched."""
    files = []
    for index in range(parts):
        f = LibraryFile(
            filename=f"{name}_{index}.gcode.3mf",
            file_path=f"/test/{name}_{index}.gcode.3mf",
            file_size=100,
            file_type="3mf",
            file_metadata={"sliced_for_model": model, "print_time_seconds": seconds, "printable_objects": {"1": name}},
        )
        db_session.add(f)
        await db_session.commit()
        files.append(f.id)
    response = await client.post(
        "/api/v1/products/",
        json={
            "name": name,
            "parts": [{"name": f"Part {i}", "matched": parts > 1} for i in range(parts)],
            "plates": [{"library_file_id": f, "pieces": [{"part": i, "pieces": 1}]} for i, f in enumerate(files)],
        },
    )
    assert response.status_code == 200, response.text
    return SimpleNamespace(id=response.json()["id"], files=files)


async def _send(client: AsyncClient, method: str, url: str, body: dict | None, connected: set[int]):
    online, status = _live(connected)
    with online, status:
        return await client.request(method, url, json=body)


async def _order(client: AsyncClient, product_id: int, connected: set[int], due_in: timedelta | None = None, **extra):
    body = {"quantity": 1, **extra}
    if due_in is not None:
        body["due_date"] = (datetime.now(timezone.utc) + due_in).isoformat()
    response = await _send(client, "POST", f"/api/v1/products/{product_id}/orders", body, connected)
    assert response.status_code == 200, response.text
    return response.json()


async def _detail(client: AsyncClient, product_id: int, connected: set[int]) -> dict:
    response = await _send(client, "GET", f"/api/v1/products/{product_id}", None, connected)
    assert response.status_code == 200, response.text
    return response.json()


async def _pending(db_session, library_file_id: int | None = None) -> list[PrintQueueItem]:
    db_session.expire_all()
    query = select(PrintQueueItem).where(PrintQueueItem.status == "pending")
    if library_file_id is not None:
        query = query.where(PrintQueueItem.library_file_id == library_file_id)
    return list((await db_session.execute(query.order_by(PrintQueueItem.position))).scalars())


# --- 1. a Base order is changed on the Orders page -------------------------------------------


async def test_a_base_orders_quantity_and_cancel_are_refused_here(
    async_client: AsyncClient, db_session, printer_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    product = await _product(async_client, db_session, "Crate", 2 * H)
    result = await _order(
        async_client, product.id, connected, external_source="base", external_ref=f"70001/{product.id}"
    )
    [order] = [o for o in result["product"]["orders"] if o["status"] == "open"]
    assert (order["external_source"], order["base_order_id"]) == ("base", 70001)

    for method, url, body in (
        ("PATCH", f"/api/v1/products/orders/{order['id']}", {"quantity": 3}),
        ("POST", f"/api/v1/products/orders/{order['id']}/cancel", None),
    ):
        response = await _send(async_client, method, url, body, connected)
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == "This order comes from Base: change it on the Orders page"

    # The sync leaves a due date set by hand alone: that one may still be set.
    response = await _send(
        async_client, "PATCH", f"/api/v1/products/orders/{order['id']}", {"due_date": "2030-01-10T12:00:00Z"}, connected
    )
    assert response.status_code == 200, response.text

    # An order entered by hand: no Base id, changed here as before.
    result = await _order(async_client, product.id, connected)
    hand = next(o for o in result["product"]["orders"] if o["status"] == "open" and o["id"] != order["id"])
    assert hand["base_order_id"] is None
    response = await _send(async_client, "PATCH", f"/api/v1/products/orders/{hand['id']}", {"quantity": 2}, connected)
    assert response.status_code == 200, response.text


# --- 3. the plan's own times ---------------------------------------------------------------------


async def test_a_job_says_the_time_the_plan_used_and_whether_it_was_learned(
    async_client: AsyncClient, db_session, printer_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    product = await _product(async_client, db_session, "Crate", 2 * H)
    result = await _order(async_client, product.id, connected)
    [job] = result["product"]["jobs"]
    # No history: the plan used the slicer's time.
    assert (job["print_time_seconds"], job["planned_seconds"], job["learned"]) == (2 * H, 2 * H, False)

    # The plate's history says it prints faster: the queue job carries that time.
    [item] = await _pending(db_session)
    item.print_time_seconds = int(1.5 * H)
    await db_session.commit()
    [job] = (await _detail(async_client, product.id, connected))["jobs"]
    assert (job["print_time_seconds"], job["planned_seconds"], job["learned"]) == (2 * H, int(1.5 * H), True)


# --- 4 and 5. products planned again behind a more urgent one; the message to the pages -----------


async def test_a_more_urgent_order_says_which_products_it_planned_again(
    async_client: AsyncClient, db_session, printer_factory
):
    a = (await printer_factory(name="P1S-A", model="P1S")).id
    b = (await printer_factory(name="P1S-B", model="P1S")).id
    connected = {a, b}
    later = await _product(async_client, db_session, "Crate", 2 * H)
    # A plate of two crates too: one printer makes both in less time than two plates one after the other.
    double = LibraryFile(
        filename="Crate_x2.gcode.3mf",
        file_path="/test/Crate_x2.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={
            "sliced_for_model": "P1S",
            "print_time_seconds": 3 * H,
            "printable_objects": {"1": "a", "2": "b"},
        },
    )
    db_session.add(double)
    await db_session.commit()
    response = await async_client.post(
        f"/api/v1/products/{later.id}/plates",
        json={"plates": [{"library_file_id": double.id, "pieces": [{"part_name": "Part 0", "pieces": 2}]}]},
    )
    assert response.status_code == 200, response.text
    sooner = await _product(async_client, db_session, "Tag", 1 * H)
    first = await _order(async_client, later.id, connected, timedelta(days=3), quantity=2)
    assert (first["also_replanned"], first["plan_failed"]) == ([], [])
    crates = {i.id for i in await _pending(db_session) if i.library_file_id != sooner.files[0]}

    broadcast = AsyncMock()
    with patch("backend.app.core.websocket.ws_manager.broadcast", broadcast):
        result = await _order(async_client, sooner.id, connected, timedelta(days=1))
    # The tag takes a printer first: the two crates are planned again around it, now on one plate of two.
    now = {i.id for i in await _pending(db_session) if i.library_file_id != sooner.files[0]}
    [entry] = result["also_replanned"]
    assert (entry["product_id"], entry["name"]) == (later.id, "Crate")
    assert entry["created"] == len(now - crates) > 0
    assert entry["replaced"] == len(crates - now)
    assert result["plan_failed"] == []
    broadcast.assert_awaited_once_with({"type": "products_replanned", "product_ids": sorted([later.id, sooner.id])})


async def test_a_product_planned_again_the_same_is_not_listed(async_client: AsyncClient, db_session, printer_factory):
    p1s = (await printer_factory(name="P1S-A", model="P1S")).id
    a1 = (await printer_factory(name="A1-A", model="A1")).id
    connected = {p1s, a1}
    later = await _product(async_client, db_session, "Crate", 2 * H)
    sooner = await _product(async_client, db_session, "Tag", 1 * H, model="A1")
    await _order(async_client, later.id, connected, timedelta(days=3), quantity=2)
    broadcast = AsyncMock()
    with patch("backend.app.core.websocket.ws_manager.broadcast", broadcast):
        result = await _order(async_client, sooner.id, connected, timedelta(days=1))
    # The crates were planned again behind the tag, the same on their own printer: not listed,
    # but announced (they may print later than before).
    assert (result["also_replanned"], result["plan_failed"]) == ([], [])
    broadcast.assert_awaited_once_with({"type": "products_replanned", "product_ids": sorted([later.id, sooner.id])})


async def test_a_failed_plan_behind_a_more_urgent_one_is_reported(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products

    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    later = await _product(async_client, db_session, "Crate", 2 * H)
    sooner = await _product(async_client, db_session, "Tag", 1 * H)
    await _order(async_client, later.id, connected, timedelta(days=3))
    real = products.replan

    async def failing(db, product_id, **kwargs):
        if product_id == later.id:
            raise RuntimeError("broken plan")
        return await real(db, product_id, **kwargs)

    with patch.object(products, "replan", side_effect=failing):
        result = await _order(async_client, sooner.id, connected, timedelta(days=1))
    assert result["also_replanned"] == []
    assert result["plan_failed"] == [{"product_id": later.id, "name": "Crate"}]


async def test_a_broadcast_that_fails_does_not_fail_the_request(async_client: AsyncClient, db_session, printer_factory):
    printer = await printer_factory(name="P1S-A", model="P1S")
    product = await _product(async_client, db_session, "Crate", 2 * H)
    broken = AsyncMock(side_effect=RuntimeError("socket gone"))
    with patch("backend.app.core.websocket.ws_manager.broadcast", broken):
        result = await _order(async_client, product.id, {printer.id})
    broken.assert_awaited_once()
    assert result["created"] == 1


async def test_cancelling_a_queue_job_and_checks_report_the_pass(
    async_client: AsyncClient, db_session, printer_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    product = await _product(async_client, db_session, "Crate", 2 * H)
    await _order(async_client, product.id, connected)
    [item] = await _pending(db_session)
    broadcast = AsyncMock()
    with patch("backend.app.core.websocket.ws_manager.broadcast", broadcast):
        response = await _send(
            async_client, "POST", f"/api/v1/products/queue-items/{item.id}/cancel", {"then": "replan"}, connected
        )
    assert response.status_code == 200, response.text
    assert (response.json()["also_replanned"], response.json()["plan_failed"]) == ([], [])
    broadcast.assert_awaited_once_with({"type": "products_replanned", "product_ids": [product.id]})


# --- 6. the plan settings ------------------------------------------------------------------------


async def test_reservation_yield_and_learn_history_round_trip(async_client: AsyncClient, db_session):
    from backend.app.models.settings import Settings

    body = (await async_client.get("/api/v1/products/settings")).json()
    assert (body["reservation_yield"], body["learn_history"]) == (True, True)
    response = await async_client.put(
        "/api/v1/products/settings",
        json={"plate_cost_minutes": 15, "reservation_yield": False, "learn_history": False},
    )
    assert response.status_code == 200, response.text
    assert (response.json()["reservation_yield"], response.json()["learn_history"]) == (False, False)
    rows = dict(
        (
            await db_session.execute(
                select(Settings.key, Settings.value).where(
                    Settings.key.in_(("product_reservation_yield", "product_learn_history"))
                )
            )
        ).all()
    )
    assert rows == {"product_reservation_yield": "false", "product_learn_history": "false"}

    # Left out or null: unchanged.
    response = await async_client.put(
        "/api/v1/products/settings", json={"plate_cost_minutes": 20, "reservation_yield": None}
    )
    assert (response.json()["reservation_yield"], response.json()["learn_history"]) == (False, False)
    response = await async_client.put(
        "/api/v1/products/settings", json={"plate_cost_minutes": 20, "learn_history": True}
    )
    assert (response.json()["reservation_yield"], response.json()["learn_history"]) == (False, True)


# --- 7. the label of an order entered by hand ------------------------------------------------------


async def test_an_order_entered_by_hand_has_no_title_that_repeats_its_label(
    async_client: AsyncClient, db_session, printer_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    product = await _product(async_client, db_session, "Crate", 2 * H)
    result = await _order(async_client, product.id, connected)
    order_id = next(o["id"] for o in result["product"]["orders"] if o["status"] == "open")
    long_note = "A note far longer than the label has room for"
    await _order(async_client, product.id, connected, notes=long_note)
    tags = (await async_client.get("/api/v1/products/order-tags")).json()["items"]
    labels = {(t["label"], t["title"]) for entry in tags.values() for t in entry["orders"]}
    assert (f"#{order_id}", "") in labels
    assert (long_note[:24], long_note) in labels


# --- 8. why an order has no estimate ----------------------------------------------------------------


async def _reason(client: AsyncClient, product_id: int, connected: set[int]) -> tuple:
    [order] = [o for o in (await _detail(client, product_id, connected))["orders"] if o["status"] == "open"]
    return order["estimated_ready_at"] is not None, order["no_estimate_reason"]


async def test_an_order_without_an_estimate_says_why(async_client: AsyncClient, db_session, printer_factory):
    printer_id = (await printer_factory(name="P1S-A", model="P1S")).id
    connected = {printer_id}
    product = await _product(async_client, db_session, "Crate", 2 * H)
    await _order(async_client, product.id, connected)
    assert await _reason(async_client, product.id, connected) == (True, None)

    # No printer can take its "Any" job now: the printer is offline.
    assert await _reason(async_client, product.id, set()) == (False, "no_printer")

    # Held for something else (a nozzle to change): no estimate, and why.
    [item] = await _pending(db_session)
    item.waiting_reason = "Nozzle: needs 0.6 mm"
    await db_session.commit()
    assert await _reason(async_client, product.id, connected) == (False, "held")

    # Nothing in the queue for it: its job was deleted.
    for item in await _pending(db_session):
        response = await async_client.delete(f"/api/v1/queue/{item.id}")
        assert response.status_code == 200, response.text
    assert await _reason(async_client, product.id, connected) == (False, "nothing_queued")


# --- 9. a hold the user released is no hold ----------------------------------------------------------


async def test_a_released_hold_does_not_count_as_moved_by_hand(async_client: AsyncClient, db_session, printer_factory):
    a = (await printer_factory(name="P1S-A", model="P1S")).id
    b = (await printer_factory(name="P1S-B", model="P1S")).id
    connected = {a, b}
    product = await _product(async_client, db_session, "Crate", 2 * H)
    await _order(async_client, product.id, connected)
    [item] = await _pending(db_session)
    reservation = await db_session.get(QueueReservation, item.id)
    assert reservation is not None
    elsewhere = a if reservation.printer_id == b else b
    reservation.printer_id = elsewhere
    reservation.source = "released"
    item_id = item.id
    await db_session.commit()
    [job] = (await _detail(async_client, product.id, connected))["jobs"]
    assert job["moved"] is False
    planned = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == item_id))).scalar_one()
    assert job["printer_id"] == planned.planned_printer_id

    # The same row from someone moving it: moved.
    reservation = await db_session.get(QueueReservation, item_id)
    reservation.source = "user"
    await db_session.commit()
    [job] = (await _detail(async_client, product.id, connected))["jobs"]
    assert (job["moved"], job["printer_id"]) == (True, elsewhere)
