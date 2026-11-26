"""Orders from Base become product orders; read-only, no buyer data kept (fork).

See services/base_sync.py. Base's API is faked: no request leaves the test.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.base_sync import BaseOrder
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob, ProductOrder, ProductStockAdjustment
from backend.app.services import base_sync

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600
TAKE, CANCELLED = 100001, 100002
# "Ship today" and "ship tomorrow": an automation moves accepted orders there within seconds.
TODAY, TOMORROW = 100011, 100012


def _order(order_id: int, lines: list[tuple[str, int]], status: int = TAKE, confirmed: int = 1795111511) -> dict:
    """A Base order as getOrders sends it, buyer data included (it must not be kept)."""
    return {
        "order_id": order_id,
        "shop_order_id": order_id - 1000,
        "external_order_id": str(order_id - 1000),
        "order_source": "allegro",
        "order_source_id": 1111,
        "order_status_id": status,
        "date_confirmed": confirmed,
        "date_add": confirmed - 60,
        "date_in_status": confirmed + 5,
        "user_login": f"nick_{order_id}",
        "email": "buyer@example.com",
        "phone": "+48000000000",
        "delivery_fullname": "Jan Kowalski",
        "delivery_address": "Ulica 1",
        "invoice_nip": "1234567890",
        "products": [
            {"sku": sku, "name": f"Name of {sku}", "quantity": qty, "attributes": "Black", "price_brutto": 10}
            for sku, qty in lines
        ],
    }


def _ts(when: datetime) -> int:
    return int(when.replace(tzinfo=timezone.utc).timestamp())


class FakeBase:
    """Answers getOrders by status, getOrderTransactionData, getOrderSources and getOrderStatusList."""

    def __init__(self):
        self.orders: list[dict] = []
        # order id -> its marketplace ship-by deadline (naive UTC); a shop order has none.
        self.ship_by: dict[int, datetime] = {}
        self.calls: list[tuple[str, dict]] = []

    async def handle(self, method: str, parameters: dict | None = None) -> dict:
        parameters = parameters or {}
        self.calls.append((method, parameters))
        if method == "getOrders":
            found = [o for o in self.orders if o["order_status_id"] == parameters.get("status_id")]
            since = parameters.get("date_confirmed_from")
            if since:
                found = [o for o in found if o["date_confirmed"] >= since]
            return {"status": "SUCCESS", "orders": found}
        if method == "getOrderTransactionData":
            ship_by = self.ship_by.get(parameters["order_id"])
            return {
                "status": "SUCCESS",
                "currency": "PLN",
                "ship_date_from": str(_ts(ship_by) - 86399) if ship_by else "",
                "ship_date_to": str(_ts(ship_by)) if ship_by else "",
            }
        if method == "getOrderSources":
            return {"status": "SUCCESS", "sources": {"allegro": {"1111": "Allegro Shop A"}, "shop": {"2222": "Sklep"}}}
        if method == "getOrderStatusList":
            return {
                "status": "SUCCESS",
                "statuses": [{"id": TAKE, "name": "Przyjęte do realizacji"}, {"id": CANCELLED, "name": "Anulowane"}],
            }
        raise AssertionError(f"the sync must only read, not call {method}")


@pytest.fixture
def fake_base(monkeypatch):
    fake = FakeBase()

    async def call(self, method, parameters=None):
        return await fake.handle(method, parameters)

    monkeypatch.setattr(base_sync.BaseClient, "call", call)
    base_sync.state.last_error = None
    base_sync._ship_checked.clear()
    yield fake


def _live(connected: set[int]):
    from backend.app.services.printer_manager import printer_manager

    idle = SimpleNamespace(state="IDLE", remaining_time=0, progress=0)
    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=lambda pid: idle),
    )


@pytest.fixture
async def shop(async_client: AsyncClient, db_session, printer_factory, fake_base):
    """A P1S, a box (lid + base, matched) with SKU SKU-BOX-100-B, and the sync set up."""
    printer = await printer_factory(name="P1S-A", model="P1S")
    files = []
    for name in ("lid", "base"):
        f = LibraryFile(
            filename=f"{name}.gcode.3mf",
            file_path=f"/test/{name}.gcode.3mf",
            file_size=1,
            file_type="3mf",
            file_metadata={"sliced_for_model": "P1S", "print_time_seconds": 2 * H, "printable_objects": {"1": name}},
        )
        db_session.add(f)
        await db_session.commit()
        files.append(f.id)
    response = await async_client.post(
        "/api/v1/products/",
        json={
            "name": "9mm 100 Black",
            "parts": [{"name": "Lid", "matched": True}, {"name": "Base", "matched": True}],
            "plates": [
                {"library_file_id": files[0], "pieces": [{"part_name": "Lid", "pieces": 1}]},
                {"library_file_id": files[1], "pieces": [{"part_name": "Base", "pieces": 1}]},
            ],
            "skus": [{"sku": "SKU-BOX-100-B"}],
        },
    )
    assert response.status_code == 200, response.text
    product = response.json()
    response = await async_client.put(
        "/api/v1/base-sync/settings",
        json={
            "api_token": "secret-token",
            "status_ids": [TAKE],
            "cancel_status_id": CANCELLED,
            "enabled": True,
            "clear_since": True,
        },
    )
    assert response.status_code == 200, response.text
    return SimpleNamespace(product_id=product["id"], printer=printer.id)


async def _sync(client: AsyncClient, connected: set[int]) -> dict:
    online, status = _live(connected)
    with online, status:
        response = await client.post("/api/v1/base-sync/sync")
    assert response.status_code == 200, response.text
    return response.json()


async def _product_orders(db_session) -> list[ProductOrder]:
    db_session.expire_all()
    return list((await db_session.execute(select(ProductOrder).order_by(ProductOrder.id))).scalars())


async def test_the_token_is_write_only(async_client: AsyncClient, shop):
    body = (await async_client.get("/api/v1/base-sync/settings")).json()
    assert body["token_set"] is True
    assert "secret-token" not in str(body)
    assert body["status_ids"] == [TAKE] and body["enabled"] is True


async def test_the_connection_test_lists_statuses_and_sources(async_client: AsyncClient, shop):
    response = await async_client.post("/api/v1/base-sync/test", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert {s["name"] for s in body["statuses"]} == {"Przyjęte do realizacji", "Anulowane"}
    assert {"key": "allegro:1111", "name": "Allegro Shop A"} in body["sources"]


async def test_a_new_order_waits_and_keeps_no_buyer_data(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5001, [("SKU-BOX-100-B", 2), ("SKU-STICKER-W", 1)])]
    result = await _sync(async_client, {shop.printer})
    assert (result["seen"], result["new"]) == (1, 1)
    assert await _product_orders(db_session) == []  # waits for someone to send it

    row = await db_session.get(BaseOrder, 5001)
    stored = str({c.name: getattr(row, c.name) for c in BaseOrder.__table__.columns})
    for buyer in ("buyer@example.com", "+48000000000", "Kowalski", "Ulica", "1234567890"):
        assert buyer not in stored
    assert row.source_name == "Allegro Shop A" and row.number == "4001"

    [listed] = (await async_client.get("/api/v1/base-sync/orders")).json()
    assert listed["state"] == "new"
    assert [(line["sku"], line["mapping"]) for line in listed["lines"]] == [
        ("SKU-BOX-100-B", "product"),
        ("SKU-STICKER-W", "unmapped"),
    ]
    skus = (await async_client.get("/api/v1/base-sync/skus")).json()
    assert skus["unmapped"] == [{"sku": "SKU-STICKER-W", "name": "Name of SKU-STICKER-W", "orders": 1}]


async def test_accepting_an_order_queues_its_prints(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5001, [("SKU-BOX-100-B", 2), ("SKU-STICKER-W", 1)])]
    await _sync(async_client, {shop.printer})
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5001/accept")
    assert response.status_code == 200, response.text
    [po] = await _product_orders(db_session)
    assert (po.product_id, po.quantity, po.external_source, po.external_ref) == (
        shop.product_id,
        2,
        "base",
        "5001/" + str(shop.product_id),
    )
    assert "Base #4001 (Allegro Shop A)" in (po.notes or "")
    items = list((await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars())
    assert items  # planned into the queue

    # The stickers are not printed: marking them clears the unmapped list.
    response = await async_client.put("/api/v1/base-sync/skus/SKU-STICKER-W", json={"product_id": None})
    assert response.status_code == 200
    assert (await async_client.get("/api/v1/base-sync/skus")).json()["unmapped"] == []


async def test_auto_accepted_orders_follow_their_lines_and_cancellations(
    async_client: AsyncClient, db_session, shop, fake_base
):
    await async_client.put("/api/v1/base-sync/settings", json={"auto_accept": True})
    fake_base.orders = [_order(5002, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    [po] = await _product_orders(db_session)
    assert (po.quantity, po.status) == (1, "open")

    # The buyer adds one more in Base: the product order follows.
    fake_base.orders = [_order(5002, [("SKU-BOX-100-B", 3)])]
    result = await _sync(async_client, {shop.printer})
    assert result["updated"] == 1
    [po] = await _product_orders(db_session)
    assert po.quantity == 3

    # Cancelled in Base: the product order is cancelled too.
    fake_base.orders = [_order(5002, [("SKU-BOX-100-B", 3)], status=CANCELLED)]
    result = await _sync(async_client, {shop.printer})
    assert result["cancelled"] == 1
    [po] = await _product_orders(db_session)
    assert po.status == "cancelled"
    assert all(method.startswith("get") for method, _ in fake_base.calls)


async def test_mapping_a_sku_later_adds_its_product_order(async_client: AsyncClient, db_session, shop, fake_base):
    await async_client.put("/api/v1/base-sync/settings", json={"auto_accept": True})
    fake_base.orders = [_order(5003, [("SKU-BOX-100-G", 1)])]
    await _sync(async_client, {shop.printer})
    assert await _product_orders(db_session) == []
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.put(
            "/api/v1/base-sync/skus/SKU-BOX-100-G", json={"product_id": shop.product_id, "units": 2}
        )
    assert response.status_code == 200, response.text
    [po] = await _product_orders(db_session)
    assert po.quantity == 2


async def test_skipping_an_order_cancels_its_open_product_orders(
    async_client: AsyncClient, db_session, shop, fake_base
):
    await async_client.put("/api/v1/base-sync/settings", json={"auto_accept": True})
    fake_base.orders = [_order(5004, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5004/skip")
    assert response.json()["state"] == "skipped"
    [po] = await _product_orders(db_session)
    assert po.status == "cancelled"


async def test_only_chosen_sources_are_taken(async_client: AsyncClient, db_session, shop, fake_base):
    await async_client.put("/api/v1/base-sync/settings", json={"sources": ["shop:2222"]})
    fake_base.orders = [_order(5005, [("SKU-BOX-100-B", 1)])]
    result = await _sync(async_client, {shop.printer})
    assert result["seen"] == 0
    assert await db_session.get(BaseOrder, 5005) is None


async def test_a_sku_belongs_to_one_product(async_client: AsyncClient, shop):
    response = await async_client.post(
        "/api/v1/products/",
        json={"name": "Other", "parts": [{"name": "Lid"}], "skus": [{"sku": "sku-box-100-b"}]},
    )
    assert response.status_code == 409


async def test_a_base_error_is_reported(async_client: AsyncClient, shop, monkeypatch):
    async def refuse(self, method, parameters=None):
        raise base_sync.BaseApiError("ERROR_BAD_TOKEN: Invalid user token")

    monkeypatch.setattr(base_sync.BaseClient, "call", refuse)
    response = await async_client.post("/api/v1/base-sync/sync")
    assert response.status_code == 502
    assert (await async_client.get("/api/v1/base-sync/settings")).json()["last_error"].startswith("ERROR_BAD_TOKEN")


async def test_parse_order_drops_buyer_data():
    data = base_sync.parse_order(_order(6000, [("X", 1), ("Y", 0)]))
    assert data is not None
    assert [line.sku for line in data.lines] == ["X"]
    assert not any(hasattr(data, field) for field in ("email", "phone", "delivery_fullname"))


async def test_setting_up_takes_orders_from_now_on(async_client: AsyncClient, db_session, printer_factory, fake_base):
    response = await async_client.put("/api/v1/base-sync/settings", json={"api_token": "t", "status_ids": [TAKE]})
    since = response.json()["since"]
    assert since is not None
    when = datetime.fromisoformat(since.replace("Z", "+00:00"))
    assert abs((datetime.now(timezone.utc) - when).total_seconds()) < 60

    now = int(datetime.now(timezone.utc).timestamp())
    fake_base.orders = [
        _order(7001, [("SKU-BOX-100-B", 1)], confirmed=now - 86400),  # before the sync was set up
        _order(7002, [("SKU-BOX-100-B", 1)], confirmed=now + 60),
    ]
    result = await _sync(async_client, set())
    assert result["seen"] == 1
    assert await db_session.get(BaseOrder, 7001) is None
    assert await db_session.get(BaseOrder, 7002) is not None
    # Base was asked from that moment on.
    [(_, parameters)] = [c for c in fake_base.calls if c[0] == "getOrders"]
    assert parameters["date_confirmed_from"] == int(when.timestamp())


async def test_a_date_can_be_set_or_cleared(async_client: AsyncClient, shop):
    response = await async_client.put("/api/v1/base-sync/settings", json={"since": "2026-11-01T00:00:00Z"})
    assert response.json()["since"] == "2026-11-01T00:00:00Z"
    response = await async_client.put("/api/v1/base-sync/settings", json={"clear_since": True})
    assert response.json()["since"] is None
    # Changing other settings leaves it alone.
    await async_client.put("/api/v1/base-sync/settings", json={"since": "2026-11-01T00:00:00Z"})
    response = await async_client.put("/api/v1/base-sync/settings", json={"poll_minutes": 10})
    assert response.json()["since"] == "2026-11-01T00:00:00Z"


async def test_orders_are_taken_from_every_chosen_status_and_due_when_they_must_ship(
    async_client: AsyncClient, db_session, shop, fake_base
):
    await async_client.put(
        "/api/v1/base-sync/settings", json={"status_ids": [TAKE, TODAY, TOMORROW], "auto_accept": True}
    )
    wednesday, thursday = datetime(2026, 11, 25, 22, 59, 59), datetime(2026, 11, 26, 22, 59, 59)
    fake_base.orders = [
        _order(5101, [("SKU-BOX-100-B", 1)], status=TODAY),
        _order(5102, [("SKU-BOX-100-B", 1)], status=TOMORROW),
        _order(5104, [("SKU-BOX-100-B", 1)], status=TAKE),  # a shop order: no ship-by date
    ]
    fake_base.ship_by = {5101: wednesday, 5102: thursday}
    result = await _sync(async_client, {shop.printer})
    assert (result["seen"], result["new"]) == (3, 3)
    assert sorted(p["status_id"] for m, p in fake_base.calls if m == "getOrders") == [TAKE, TODAY, TOMORROW]

    due = {po.external_ref.split("/")[0]: po.due_date for po in await _product_orders(db_session)}
    assert due == {"5101": wednesday, "5102": thursday, "5104": None}
    listed = {o["order_id"]: o["ship_by"] for o in (await async_client.get("/api/v1/base-sync/orders")).json()}
    assert listed[5101] == "2026-11-25T22:59:59Z" and listed[5104] is None

    # Each order's transaction is read once, also the one that has no date.
    await _sync(async_client, {shop.printer})
    asked = [p["order_id"] for m, p in fake_base.calls if m == "getOrderTransactionData"]
    assert sorted(asked) == [5101, 5102, 5104]

    # Working days after confirmation for orders without a ship-by date; the others keep theirs.
    online, status = _live({shop.printer})
    with online, status:
        await async_client.put("/api/v1/base-sync/settings", json={"handling_days": 2})
    due = {po.external_ref.split("/")[0]: po.due_date for po in await _product_orders(db_session)}
    assert due["5101"] == wednesday
    assert due["5104"] is not None and due["5104"] > datetime.fromtimestamp(1795111511, tz=timezone.utc).replace(
        tzinfo=None
    )


async def test_ship_dates_are_read_a_few_a_pass(async_client: AsyncClient, db_session, shop, fake_base, monkeypatch):
    monkeypatch.setattr(base_sync, "SHIP_DATE_READS", 1)
    await async_client.put("/api/v1/base-sync/settings", json={"status_ids": [TODAY], "auto_accept": True})
    fake_base.orders = [
        _order(5401, [("SKU-BOX-100-B", 1)], status=TODAY, confirmed=1795111511),
        _order(5402, [("SKU-BOX-100-B", 1)], status=TODAY, confirmed=1795111600),
    ]
    fake_base.ship_by = {5401: datetime(2026, 11, 25, 22, 59, 59), 5402: datetime(2026, 11, 26, 22, 59, 59)}
    await _sync(async_client, {shop.printer})
    due = {po.external_ref.split("/")[0]: po.due_date for po in await _product_orders(db_session)}
    assert due == {"5401": datetime(2026, 11, 25, 22, 59, 59), "5402": None}  # the oldest first
    await _sync(async_client, {shop.printer})
    due = {po.external_ref.split("/")[0]: po.due_date for po in await _product_orders(db_session)}
    assert due["5402"] == datetime(2026, 11, 26, 22, 59, 59)


async def test_a_due_date_set_by_hand_stays(async_client: AsyncClient, db_session, shop, fake_base):
    await async_client.put("/api/v1/base-sync/settings", json={"status_ids": [TOMORROW], "auto_accept": True})
    fake_base.orders = [_order(5201, [("SKU-BOX-100-B", 1)], status=TOMORROW)]
    fake_base.ship_by = {5201: datetime(2026, 11, 26, 22, 59, 59)}
    await _sync(async_client, {shop.printer})
    [po] = await _product_orders(db_session)
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.patch(
            f"/api/v1/products/orders/{po.id}", json={"due_date": "2026-12-10T12:00:00Z"}
        )
    assert response.status_code == 200, response.text
    # Base moves it from "tomorrow" to "today" in the morning: the date set by hand stays.
    fake_base.orders = [_order(5201, [("SKU-BOX-100-B", 1)], status=TODAY)]
    await async_client.put("/api/v1/base-sync/settings", json={"status_ids": [TODAY, TOMORROW]})
    await _sync(async_client, {shop.printer})
    [po] = await _product_orders(db_session)
    assert po.due_date == datetime(2026, 12, 10, 12, 0)


async def test_a_setting_stored_with_one_status_reads_as_a_list():
    assert base_sync.parse_config(f'{{"status_id": {TAKE}}}').status_ids == [TAKE]
    assert base_sync.parse_config('{"status_ids": [1, "2", 1, null]}').status_ids == [1, 2]


async def test_an_order_is_sent_line_by_line_with_parts_on_hand(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5501, [("SKU-BOX-100-B", 3)])]
    await _sync(async_client, {shop.printer})
    product = (await async_client.get(f"/api/v1/products/{shop.product_id}")).json()
    parts = {p["name"]: p["id"] for p in product["parts"]}

    # Two of the three boxes are printed, and a lid for one of them is on the shelf.
    choice = {"product_id": shop.product_id, "units": 2, "have": [{"part_id": parts["Lid"], "pieces": 1}]}
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5501/accept", json={"products": [choice]})
    assert response.status_code == 200, response.text
    assert response.json()["held"] == {str(shop.product_id): 1}
    [po] = await _product_orders(db_session)
    assert (po.quantity, po.status) == (2, "open")
    [adjustment] = list((await db_session.execute(select(ProductStockAdjustment))).scalars())
    assert (adjustment.part_id, adjustment.printer_id, adjustment.delta) == (parts["Lid"], None, 1)
    assert "Base #4501" in adjustment.note
    planned = list((await db_session.execute(select(ProductJob).where(ProductJob.status == "planned"))).scalars())
    printed: dict[int, int] = {}
    for job in planned:
        for part_id, n in job.pieces.items():
            printed[int(part_id)] = printed.get(int(part_id), 0) + n
    # The lid on hand goes with a base from any printer: one lid and two bases to print.
    assert printed == {parts["Lid"]: 1, parts["Base"]: 2}

    # Changing it with the same lid on hand puts nothing in twice; none on hand takes it out.
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5501/accept", json={"products": [choice]})
    assert response.json()["on_hand"] == {str(parts["Lid"]): 1}
    deltas = [a.delta for a in (await db_session.execute(select(ProductStockAdjustment))).scalars()]
    assert sum(deltas) == 1
    with online, status:
        await async_client.post(
            "/api/v1/base-sync/orders/5501/accept",
            json={"products": [{**choice, "have": []}]},
        )
    db_session.expire_all()
    deltas = [a.delta for a in (await db_session.execute(select(ProductStockAdjustment))).scalars()]
    assert sum(deltas) == 0
    with online, status:
        await async_client.post("/api/v1/base-sync/orders/5501/accept", json={"products": [choice]})

    # The buyer adds a box in Base: the one held back stays held back.
    fake_base.orders = [_order(5501, [("SKU-BOX-100-B", 4)])]
    await _sync(async_client, {shop.printer})
    [po] = await _product_orders(db_session)
    assert po.quantity == 3

    # Nothing printed for the order after all: its product order is cancelled.
    with online, status:
        response = await async_client.post(
            "/api/v1/base-sync/orders/5501/accept", json={"products": [{"product_id": shop.product_id, "units": 0}]}
        )
    assert response.status_code == 200, response.text
    [po] = await _product_orders(db_session)
    assert po.status == "cancelled"

    response = await async_client.post(
        "/api/v1/base-sync/orders/5501/accept",
        json={"products": [{"product_id": shop.product_id, "units": 1, "have": [{"part_id": 999999, "pieces": 1}]}]},
    )
    assert response.status_code == 400


async def test_sending_an_order_can_be_taken_back(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5601, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    product = (await async_client.get(f"/api/v1/products/{shop.product_id}")).json()
    lid = next(p["id"] for p in product["parts"] if p["name"] == "Lid")
    online, status = _live({shop.printer})
    with online, status:
        await async_client.post(
            "/api/v1/base-sync/orders/5601/accept",
            json={"products": [{"product_id": shop.product_id, "units": 1, "have": [{"part_id": lid, "pieces": 1}]}]},
        )
        response = await async_client.post("/api/v1/base-sync/orders/5601/reset")
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["state"], body["held"], body["on_hand"]) == ("new", {}, {})
    [po] = await _product_orders(db_session)
    assert po.status == "cancelled"
    deltas = [a.delta for a in (await db_session.execute(select(ProductStockAdjustment))).scalars()]
    assert sum(deltas) == 0


def _shop_order(order_id: int, confirmed: int) -> dict:
    order = _order(order_id, [("SKU-BOX-100-B", 1)], confirmed=confirmed)
    return {**order, "order_source": "shop", "order_source_id": 2222, "shop_order_id": order_id - 4000}


async def test_waiting_orders_come_in_the_order_they_are_made(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [
        _order(5701, [("SKU-BOX-100-B", 1)], confirmed=1795111511),
        _order(5702, [("SKU-BOX-100-B", 1)], confirmed=1795111600),
        _shop_order(5704, confirmed=1795111800),  # shop orders: no ship-by date
        _shop_order(5703, confirmed=1795111700),
    ]
    fake_base.ship_by = {5701: datetime(2026, 11, 27, 22, 59, 59), 5702: datetime(2026, 11, 25, 22, 59, 59)}
    await _sync(async_client, {shop.printer})
    listed = (await async_client.get("/api/v1/base-sync/orders?state=new")).json()
    # Allegro by ship-by date, then the shop's oldest first.
    assert [o["order_id"] for o in listed] == [5702, 5701, 5703, 5704]
    # Allegro orders are labelled with the buyer's nick, the shop's with their number.
    assert {o["order_id"]: o["label"] for o in listed} == {
        5701: "nick_5701",
        5702: "nick_5702",
        5703: "#1703",
        5704: "#1704",
    }
    allegro = (await async_client.get("/api/v1/base-sync/orders?state=new&source=allegro")).json()
    assert [o["order_id"] for o in allegro] == [5702, 5701]
    shop_only = (await async_client.get("/api/v1/base-sync/orders?state=new&source=shop")).json()
    assert [o["order_id"] for o in shop_only] == [5703, 5704]


async def test_a_waiting_order_keeps_a_draft_until_it_is_sent(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5801, [("SKU-BOX-100-B", 2)])]
    await _sync(async_client, {shop.printer})
    product = (await async_client.get(f"/api/v1/products/{shop.product_id}")).json()
    base = next(p["id"] for p in product["parts"] if p["name"] == "Base")

    # "I have a base already": saved on the waiting order, nothing in stock or the queue yet.
    response = await async_client.post(
        "/api/v1/base-sync/orders/5801/draft",
        json={"products": [{"product_id": shop.product_id, "units": 2, "have": [{"part_id": base, "pieces": 1}]}]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["state"], body["draft"]) == (
        "new",
        {"held": {}, "on_hand": {str(base): 1}, "nothing_to_print": False},
    )
    assert list((await db_session.execute(select(ProductStockAdjustment))).scalars()) == []
    assert await _product_orders(db_session) == []

    # Sent as it stands: the draft is applied (the base goes into stock) and cleared.
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5801/accept")
    body = response.json()
    assert (body["state"], body["draft"], body["on_hand"]) == ("accepted", None, {str(base): 1})
    [po] = await _product_orders(db_session)
    assert po.quantity == 2
    # In production it shows how far its parts are, the base on hand counted.
    [progress] = body["progress"]
    parts = {p["name"]: p for p in progress["parts"]}
    assert (parts["Base"]["ready"], parts["Base"]["needed"], parts["Base"]["on_hand"]) == (1, 2, 1)
    assert parts["Lid"]["ready"] == 0
    assert body["source_kind"] == "allegro"

    # An accepted order keeps no draft.
    response = await async_client.post(
        "/api/v1/base-sync/orders/5801/draft", json={"products": [{"product_id": shop.product_id, "units": 1}]}
    )
    assert response.status_code == 409


async def test_an_order_held_back_in_full_is_ready_to_pack(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5811, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})

    # "Print 0 of 1": the draft leaves nothing to print.
    response = await async_client.post(
        "/api/v1/base-sync/orders/5811/draft", json={"products": [{"product_id": shop.product_id, "units": 0}]}
    )
    assert response.status_code == 200, response.text
    assert response.json()["draft"]["nothing_to_print"] is True

    # Sent, it has no product order and can be packed at once.
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5811/accept")
    body = response.json()
    assert (body["state"], body["held"], body["ready"]) == ("accepted", {str(shop.product_id): 1}, True)
    assert await _product_orders(db_session) == []

    # Ready orders are listed apart from the ones in production.
    ready = (await async_client.get("/api/v1/base-sync/orders?state=ready")).json()
    in_production = (await async_client.get("/api/v1/base-sync/orders?state=accepted")).json()
    assert ([o["order_id"] for o in ready], in_production) == ([5811], [])
    counts = (await async_client.get("/api/v1/base-sync/orders/counts")).json()
    assert (counts["ready"], counts["accepted"]) == ({"allegro": 1, "shop": 0}, {"allegro": 0, "shop": 0})


async def test_an_order_with_every_part_on_hand_is_ready_to_pack(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5812, [("SKU-BOX-100-B", 2)])]
    await _sync(async_client, {shop.printer})
    product = (await async_client.get(f"/api/v1/products/{shop.product_id}")).json()
    parts = {p["name"]: p["id"] for p in product["parts"]}

    # One part on the shelf still leaves the other to print.
    response = await async_client.post(
        "/api/v1/base-sync/orders/5812/draft",
        json={
            "products": [{"product_id": shop.product_id, "units": 2, "have": [{"part_id": parts["Lid"], "pieces": 2}]}]
        },
    )
    assert response.json()["draft"]["nothing_to_print"] is False

    # Both on the shelf: nothing to print.
    have = [{"part_id": part_id, "pieces": 2} for part_id in parts.values()]
    response = await async_client.post(
        "/api/v1/base-sync/orders/5812/draft",
        json={"products": [{"product_id": shop.product_id, "units": 2, "have": have}]},
    )
    assert response.json()["draft"]["nothing_to_print"] is True

    # Sent, its product order is done from those pieces: it can be packed.
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5812/accept")
    body = response.json()
    assert (body["state"], body["ready"]) == ("accepted", True)
    [po] = await _product_orders(db_session)
    assert po.status == "done"


async def test_an_order_still_printing_stays_in_production(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5813, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    online, status = _live({shop.printer})
    with online, status:
        await async_client.post("/api/v1/base-sync/orders/5813/accept")
    in_production = (await async_client.get("/api/v1/base-sync/orders?state=accepted")).json()
    assert [(o["order_id"], o["ready"]) for o in in_production] == [(5813, False)]
    assert (await async_client.get("/api/v1/base-sync/orders?state=ready")).json() == []
    counts = (await async_client.get("/api/v1/base-sync/orders/counts")).json()
    assert (counts["accepted"]["allegro"], counts["ready"]["allegro"]) == (1, 0)


async def test_order_counts_by_state_and_source(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5901, [("SKU-BOX-100-B", 1)]), _shop_order(5902, confirmed=1795111800)]
    await _sync(async_client, {shop.printer})
    counts = (await async_client.get("/api/v1/base-sync/orders/counts")).json()
    assert counts["new"] == {"allegro": 1, "shop": 1}
    assert counts["accepted"] == {"allegro": 0, "shop": 0}


async def _accepted(client: AsyncClient, connected: set[int]) -> dict:
    online, status = _live(connected)
    with online, status:
        response = await client.get("/api/v1/base-sync/orders", params={"state": "accepted"})
    assert response.status_code == 200, response.text
    [order] = response.json()
    return order


def _missing(order: dict) -> int:
    return sum(part["missing"] for progress in order["progress"] for part in progress["parts"])


async def test_an_order_whose_print_left_the_queue_says_so_and_is_sent_again(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5101, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5101/accept")
    assert response.status_code == 200, response.text
    assert _missing(await _accepted(async_client, {shop.printer})) == 0

    # Someone deletes one of its prints from the queue.
    pending = list(
        (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars()
    )
    assert len(pending) == 2
    response = await async_client.delete(f"/api/v1/queue/{pending[0].id}")
    assert response.status_code == 200, response.text
    assert _missing(await _accepted(async_client, {shop.printer})) == 1

    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5101/requeue")
    assert response.status_code == 200, response.text
    assert _missing(response.json()) == 0
    db_session.expire_all()
    pending = list(
        (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars()
    )
    assert len(pending) == 2


async def test_only_an_order_in_production_is_sent_again(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5102, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    response = await async_client.post("/api/v1/base-sync/orders/5102/requeue")
    assert response.status_code == 409


async def test_withdrawing_a_base_order_from_its_print_in_the_queue(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5103, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    online, status = _live({shop.printer})
    with online, status:
        await async_client.post("/api/v1/base-sync/orders/5103/accept")
    tags = (await async_client.get("/api/v1/products/order-tags")).json()["items"]
    pending = list(
        (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars()
    )
    served = [t["product_order_id"] for t in tags[str(pending[0].id)]["orders"]]
    with online, status:
        response = await async_client.post(
            f"/api/v1/products/queue-items/{pending[0].id}/cancel", json={"then": "withdraw", "orders": served}
        )
    assert response.status_code == 200, response.text
    assert response.json()["withdrawn_base_orders"] == [5103]
    db_session.expire_all()
    assert await db_session.scalar(select(BaseOrder.state).where(BaseOrder.order_id == 5103)) == "skipped"
    # Both of its prints left the queue: the one cancelled and the one only it needed.
    assert (
        list((await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars())
        == []
    )


async def _accept(client: AsyncClient, order_id: int, connected: set[int]) -> dict:
    online, status = _live(connected)
    with online, status:
        response = await client.post(f"/api/v1/base-sync/orders/{order_id}/accept")
    assert response.status_code == 200, response.text
    return response.json()


async def _print_everything(db_session, printer_id: int) -> None:
    """Every waiting print finishes on the printer; the products follow."""
    from backend.app.services import products

    items = list((await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars())
    for item in items:
        item.status = "completed"
        item.printer_id = printer_id
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [i.id for i in items])
    await db_session.commit()


async def _stock(client: AsyncClient, product_id: int, connected: set[int]) -> dict[str, int]:
    online, status = _live(connected)
    with online, status:
        detail = (await client.get(f"/api/v1/products/{product_id}")).json()
    names = {p["id"]: p["name"] for p in detail["parts"]}
    return {names[s["part_id"]]: s["pieces"] for s in detail["stock"]}


async def test_withdrawing_a_ready_order_can_put_its_boxes_back_in_stock(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5201, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5201, {shop.printer})
    await _print_everything(db_session, shop.printer)
    [po] = await _product_orders(db_session)
    assert po.status == "done"
    assert await _stock(async_client, shop.product_id, {shop.printer}) == {}

    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5201/skip", json={"return_done": True})
    assert response.status_code == 200, response.text
    assert response.json()["state"] == "skipped"
    [po] = await _product_orders(db_session)
    assert (po.status, po.consumed) == ("cancelled", None)
    assert await _stock(async_client, shop.product_id, {shop.printer}) == {"Lid": 1, "Base": 1}

    # Sent again (Undo): the box on the shelf is its again, nothing is printed.
    await _accept(async_client, 5201, {shop.printer})
    [po] = await _product_orders(db_session)
    assert po.status == "done"
    assert await _stock(async_client, shop.product_id, {shop.printer}) == {}


async def test_withdrawing_a_ready_order_keeps_its_boxes_unless_asked(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5202, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5202, {shop.printer})
    await _print_everything(db_session, shop.printer)
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5202/skip")
    assert response.status_code == 200, response.text
    [po] = await _product_orders(db_session)
    assert po.status == "done"


async def test_an_order_cancelled_in_base_before_it_left_gives_its_boxes_back(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5203, [("SKU-BOX-100-B", 1)]), _order(5204, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5203, {shop.printer})
    await _accept(async_client, 5204, {shop.printer})
    await _print_everything(db_session, shop.printer)
    assert [po.status for po in await _product_orders(db_session)] == ["done", "done"]

    # 5204 was packed and moved on in Base; then both are cancelled.
    fake_base.orders = [_order(5203, [("SKU-BOX-100-B", 1)]), _order(5204, [("SKU-BOX-100-B", 1)], status=100003)]
    await _sync(async_client, {shop.printer})
    fake_base.orders = [
        _order(5203, [("SKU-BOX-100-B", 1)], status=CANCELLED),
        _order(5204, [("SKU-BOX-100-B", 1)], status=CANCELLED),
    ]
    result = await _sync(async_client, {shop.printer})
    assert result["cancelled"] == 2
    statuses = {po.external_ref.split("/")[0]: po.status for po in await _product_orders(db_session)}
    # The one still on the shelf is back in stock; the one that left stays done.
    assert statuses == {"5203": "cancelled", "5204": "done"}
    assert await _stock(async_client, shop.product_id, {shop.printer}) == {"Lid": 1, "Base": 1}


async def _listed(client: AsyncClient, state: str, connected: set[int]) -> list[dict]:
    online, status = _live(connected)
    with online, status:
        response = await client.get("/api/v1/base-sync/orders", params={"state": state})
    assert response.status_code == 200, response.text
    return response.json()


async def _finish(db_session, items: list[PrintQueueItem], printer_id: int) -> None:
    from backend.app.services import products

    for item in items:
        item.status = "completed"
        item.printer_id = printer_id
    await db_session.commit()
    await products.after_queue_items_changed(db_session, [i.id for i in items])
    await db_session.commit()


async def test_an_order_packed_in_base_prints_nothing_more(async_client: AsyncClient, db_session, shop, fake_base):
    fake_base.orders = [_order(5301, [("SKU-BOX-100-B", 2)]), _order(5302, [("SKU-BOX-100-B", 1), ("SKU-X", 1)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5301, {shop.printer})
    db_session.expire_all()
    pending = list(
        (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars()
    )
    files = {f.id: f.filename for f in (await db_session.execute(select(LibraryFile))).scalars()}
    lids = [i for i in pending if files[i.library_file_id].startswith("lid")]
    bases = [i for i in pending if files[i.library_file_id].startswith("base")]
    assert (len(lids), len(bases)) == (2, 2)
    # One box and one more lid are printed; a base still waits.
    await _finish(db_session, [*lids, bases[0]], shop.printer)
    assert [po.status for po in await _product_orders(db_session)] == ["open"]
    assert [o["order_id"] for o in await _listed(async_client, "accepted", {shop.printer})] == [5301]

    # Both are packed in Base (moved on to "to send"): the one in production
    # takes what was printed for it and nothing more is printed; the waiting one
    # was packed without Bambuddy.
    fake_base.orders = [
        _order(5301, [("SKU-BOX-100-B", 2)], status=100003),
        _order(5302, [("SKU-BOX-100-B", 1), ("SKU-X", 1)], status=100003),
    ]
    result = await _sync(async_client, {shop.printer})
    assert result["packed"] == 2
    [po] = await _product_orders(db_session)
    assert po.status == "done"
    lid_id, base_id = sorted(int(k) for k in po.consumed)
    assert {int(k): v for k, v in po.consumed.items()} == {
        lid_id: {str(shop.printer): 2},
        base_id: {str(shop.printer): 1},
    }
    db_session.expire_all()
    assert (
        list((await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars())
        == []
    )
    assert await _stock(async_client, shop.product_id, {shop.printer}) == {}

    # Listed with the ready ones, as packed; not waiting, not in production.
    assert await _listed(async_client, "new", {shop.printer}) == []
    assert await _listed(async_client, "accepted", {shop.printer}) == []
    ready = await _listed(async_client, "ready", {shop.printer})
    assert {o["order_id"]: o["packed"] for o in ready} == {5301: True, 5302: True}
    counts = (await async_client.get("/api/v1/base-sync/orders/counts")).json()
    assert counts["new"]["allegro"] == counts["accepted"]["allegro"] == 0
    assert counts["ready"]["allegro"] == 2
    # Its unmapped SKU is nobody's worry any more.
    assert (await async_client.get("/api/v1/base-sync/skus")).json()["unmapped"] == []
    # And it is not sent to production any more.
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post("/api/v1/base-sync/orders/5302/accept")
    assert response.status_code == 409

    # A lid of it found bad afterwards does not open it again.
    db_session.expire_all()
    lid_job = next(
        j
        for j in (await db_session.execute(select(ProductJob).where(ProductJob.status == "done"))).scalars()
        if str(lid_id) in (j.pieces or {})
    )
    online, status = _live({shop.printer})
    with online, status:
        response = await async_client.post(
            f"/api/v1/products/jobs/{lid_job.id}/check", json={"rejected": [{"part_id": lid_id, "pieces": 1}]}
        )
    assert response.status_code == 200, response.text
    [po] = await _product_orders(db_session)
    assert po.status == "done"
    db_session.expire_all()
    assert (
        list((await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars())
        == []
    )


async def test_a_packed_order_takes_its_pieces_ahead_of_an_earlier_one(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [
        _order(5303, [("SKU-BOX-100-B", 1)]),
        _order(5304, [("SKU-BOX-100-B", 1)], confirmed=1795111611),
    ]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5303, {shop.printer})
    await _accept(async_client, 5304, {shop.printer})
    # A box is in stock that is not counted yet: the earlier order would get it.
    db_session.add_all(
        [
            ProductStockAdjustment(part_id=part_id, printer_id=shop.printer, delta=1)
            for part_id in (await _part_ids(async_client, shop.product_id, {shop.printer}))
        ]
    )
    await db_session.commit()

    # The later one is packed: the box went into it, the earlier one still needs one.
    fake_base.orders = [_order(5303, [("SKU-BOX-100-B", 1)]), _order(5304, [("SKU-BOX-100-B", 1)], status=100003)]
    await _sync(async_client, {shop.printer})
    statuses = {po.external_ref.split("/")[0]: po.status for po in await _product_orders(db_session)}
    assert statuses == {"5303": "open", "5304": "done"}
    assert await _stock(async_client, shop.product_id, {shop.printer}) == {}


async def _part_ids(client: AsyncClient, product_id: int, connected: set[int]) -> list[int]:
    online, status = _live(connected)
    with online, status:
        detail = (await client.get(f"/api/v1/products/{product_id}")).json()
    return [p["id"] for p in detail["parts"]]


async def _preview(client: AsyncClient, order_id: int, body: dict | None, connected: set[int]) -> dict:
    online, status = _live(connected)
    with online, status:
        response = await client.post(f"/api/v1/base-sync/orders/{order_id}/skip/preview", json=body or {})
    assert response.status_code == 200, response.text
    return response.json()


async def test_the_withdraw_preview_says_what_would_happen_and_saves_nothing(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5205, [("SKU-BOX-100-B", 1)]), _order(5206, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5205, {shop.printer})
    await _accept(async_client, 5206, {shop.printer})
    db_session.expire_all()
    pending_ids = list(
        (await db_session.execute(select(PrintQueueItem.id).where(PrintQueueItem.status == "pending"))).scalars()
    )
    assert len(pending_ids) == 4
    # One of them is printing for 5205 now.
    tags = (await async_client.get("/api/v1/products/order-tags")).json()["items"]
    po_5205 = next(po.id for po in await _product_orders(db_session) if po.external_ref.startswith("5205/"))
    running_id = next(i for i in pending_ids if po_5205 in [t["product_order_id"] for t in tags[str(i)]["orders"]])
    running = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == running_id))).scalar_one()
    running.status = "printing"
    running.started_at = running.created_at
    await db_session.commit()

    preview = await _preview(async_client, 5205, None, {shop.printer})
    [printing] = preview["printing"]
    assert printing["queue_item_id"] == running_id
    # The piece printing for it now goes to 5206 instead: a lid and a base leave the queue,
    # nothing is left over for stock.
    assert sorted(p["name"] for r in preview["removed"] for p in r["pieces"]) == ["Base", "Lid"]
    assert all(r["filename"] and r["printer_name"] == "P1S-A" for r in preview["removed"])
    assert preview["added"] == []
    assert preview["to_stock"] == []
    assert preview["done"] == []

    # Nothing was saved.
    db_session.expire_all()
    assert await db_session.scalar(select(BaseOrder.state).where(BaseOrder.order_id == 5205)) == "accepted"
    statuses = sorted(
        (await db_session.execute(select(PrintQueueItem.status).where(PrintQueueItem.id.in_(pending_ids)))).scalars()
    )
    assert statuses == ["pending", "pending", "pending", "printing"]
    assert all(po.status == "open" for po in await _product_orders(db_session))


async def test_the_withdraw_preview_of_a_ready_order_lists_its_boxes(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5207, [("SKU-BOX-100-B", 2)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5207, {shop.printer})
    await _print_everything(db_session, shop.printer)
    preview = await _preview(async_client, 5207, {"return_done": True}, {shop.printer})
    assert preview["done"] == [{"product_id": shop.product_id, "name": "9mm 100 Black", "units": 2}]
    assert sorted((p["name"], p["pieces"]) for p in preview["to_stock"]) == [("Base", 2), ("Lid", 2)]
    assert preview["removed"] == [] and preview["printing"] == []
    [po] = await _product_orders(db_session)
    assert po.status == "done"


async def test_the_withdraw_preview_puts_a_piece_printing_for_no_one_else_in_stock(
    async_client: AsyncClient, db_session, shop, fake_base
):
    fake_base.orders = [_order(5208, [("SKU-BOX-100-B", 1)])]
    await _sync(async_client, {shop.printer})
    await _accept(async_client, 5208, {shop.printer})
    db_session.expire_all()
    items = list(
        (
            await db_session.execute(
                select(PrintQueueItem).where(PrintQueueItem.status == "pending").order_by(PrintQueueItem.position)
            )
        ).scalars()
    )
    items[0].status = "printing"
    items[0].started_at = items[0].created_at
    await db_session.commit()
    preview = await _preview(async_client, 5208, None, {shop.printer})
    [printing] = preview["printing"]
    [removed] = preview["removed"]
    assert printing["pieces"][0]["name"] != removed["pieces"][0]["name"]
    assert [(p["name"], p["pieces"]) for p in preview["to_stock"]] == [
        (printing["pieces"][0]["name"], printing["pieces"][0]["pieces"])
    ]
