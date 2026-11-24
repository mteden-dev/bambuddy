"""Orders from Base become product orders; read-only, no buyer data kept (fork).

See services/base_sync.py. Base's API is faked: no request leaves the test.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.base_sync import BaseOrder
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductOrder
from backend.app.services import base_sync

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600
TAKE, CANCELLED = 100001, 100002


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


class FakeBase:
    """Answers getOrders by status, getOrderSources and getOrderStatusList."""

    def __init__(self):
        self.orders: list[dict] = []
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
            "status_id": TAKE,
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
    assert body["status_id"] == TAKE and body["enabled"] is True


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

    # Moved on by hand in Base: the prints stay.
    fake_base.orders = [_order(5002, [("SKU-BOX-100-B", 3)], status=100003)]
    await _sync(async_client, {shop.printer})
    [po] = await _product_orders(db_session)
    assert po.status == "open"
    assert (await db_session.get(BaseOrder, 5002)).in_status is False

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
    from datetime import datetime, timezone

    response = await async_client.put("/api/v1/base-sync/settings", json={"api_token": "t", "status_id": TAKE})
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
