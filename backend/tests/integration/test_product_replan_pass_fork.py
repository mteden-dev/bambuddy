"""Product replans as one pass: the most urgent first, on lanes without the products behind it (fork).

See services/products.py (``replan_pass``, ``replan``).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.products import ProductJob

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600


def _live(connected: set[int]):
    from backend.app.services.printer_manager import printer_manager

    idle = SimpleNamespace(state="IDLE", remaining_time=0, progress=0)
    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=lambda pid: idle),
    )


async def _product(client: AsyncClient, db_session, name: str, model: str, seconds: int) -> SimpleNamespace:
    """A product of one part, printed one piece per plate."""
    f = LibraryFile(
        filename=f"{name}.gcode.3mf",
        file_path=f"/test/{name}.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={"sliced_for_model": model, "print_time_seconds": seconds, "printable_objects": {"1": name}},
    )
    db_session.add(f)
    await db_session.commit()
    response = await client.post(
        "/api/v1/products/",
        json={
            "name": name,
            "parts": [{"name": name}],
            "plates": [{"library_file_id": f.id, "pieces": [{"part": 0, "pieces": 1}]}],
        },
    )
    assert response.status_code == 200, response.text
    return SimpleNamespace(id=response.json()["id"], file=f.id)


async def _order(client: AsyncClient, product_id: int, quantity: int, due_in: timedelta, connected: set[int]) -> dict:
    due = datetime.now(timezone.utc) + due_in
    online, status = _live(connected)
    with online, status:
        response = await client.post(
            f"/api/v1/products/{product_id}/orders", json={"quantity": quantity, "due_date": due.isoformat()}
        )
    assert response.status_code == 200, response.text
    return response.json()


async def _items(db_session, library_file_id: int) -> list[PrintQueueItem]:
    db_session.expire_all()
    rows = await db_session.execute(
        select(PrintQueueItem)
        .where(PrintQueueItem.status == "pending", PrintQueueItem.library_file_id == library_file_id)
        .order_by(PrintQueueItem.position)
    )
    return list(rows.scalars())


def _spy():
    """Patch ``replan`` to record (product id, ignore_items) of each call."""
    from backend.app.services import products

    calls: list[tuple[int, frozenset[int]]] = []
    real = products.replan

    async def recording(db, product_id, **kwargs):
        calls.append((product_id, kwargs.get("ignore_items", frozenset())))
        return await real(db, product_id, **kwargs)

    return calls, patch.object(products, "replan", side_effect=recording)


async def test_a_sooner_order_is_planned_on_the_lane_without_the_later_ones_jobs(
    async_client: AsyncClient, db_session, printer_factory
):
    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    later = await _product(async_client, db_session, "Crate", "P1S", 2 * H)
    sooner = await _product(async_client, db_session, "Tag", "P1S", 1 * H)
    await _order(async_client, later.id, 2, timedelta(days=3), connected)
    crates = [i.id for i in await _items(db_session, later.file)]
    assert len(crates) == 2

    calls, spy = _spy()
    with spy:
        result = await _order(async_client, sooner.id, 1, timedelta(days=1), connected)
    # The tag is planned first, without the crates' waiting jobs; then the
    # crates are planned again behind it.
    assert calls == [(sooner.id, frozenset(crates)), (later.id, frozenset())]
    # So its plate starts when the printer is free, not after the crates' 4 h.
    finish = datetime.fromisoformat(result["finish_at"].replace("Z", "+00:00"))
    assert finish < datetime.now(timezone.utc) + timedelta(hours=2)
    [tag] = [i.position for i in await _items(db_session, sooner.file)]
    assert all(tag < crate for crate in [i.position for i in await _items(db_session, later.file)])


async def test_a_product_planned_again_the_same_keeps_its_queue_jobs(
    async_client: AsyncClient, db_session, printer_factory
):
    p1s = await printer_factory(name="P1S-A", model="P1S")
    a1 = await printer_factory(name="A1-A", model="A1")
    connected = {p1s.id, a1.id}
    later = await _product(async_client, db_session, "Crate", "P1S", 2 * H)
    sooner = await _product(async_client, db_session, "Tag", "A1", 1 * H)
    await _order(async_client, later.id, 2, timedelta(days=3), connected)
    before = {i.id: i.position for i in await _items(db_session, later.file)}
    jobs_before = set((await db_session.execute(select(ProductJob.id))).scalars())

    calls, spy = _spy()
    with spy:
        await _order(async_client, sooner.id, 1, timedelta(days=1), connected)
    assert [product_id for product_id, _ in calls] == [sooner.id, later.id]
    # Planned again on its own printer, the same: the same queue jobs, where they were.
    after = {i.id: i.position for i in await _items(db_session, later.file)}
    assert set(after) == set(before)
    assert jobs_before <= set((await db_session.execute(select(ProductJob.id))).scalars())


async def test_a_product_planned_again_whose_plan_fails_does_not_fail_the_request(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products

    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    later = await _product(async_client, db_session, "Crate", "P1S", 2 * H)
    sooner = await _product(async_client, db_session, "Tag", "P1S", 1 * H)
    await _order(async_client, later.id, 2, timedelta(days=3), connected)
    crates = [i.id for i in await _items(db_session, later.file)]
    real = products.replan

    async def failing(db, product_id, **kwargs):
        outcome = await real(db, product_id, **kwargs)
        if product_id == later.id:
            raise RuntimeError("broken plan")
        return outcome

    with patch.object(products, "replan", side_effect=failing):
        result = await _order(async_client, sooner.id, 1, timedelta(days=1), connected)
    assert result["created"] == 1
    assert len(await _items(db_session, sooner.file)) == 1
    # The crates' jobs are left as they were.
    assert [i.id for i in await _items(db_session, later.file)] == crates


async def test_base_sync_plans_the_soonest_due_first(async_client: AsyncClient, db_session, printer_factory):
    from backend.app.services import base_sync

    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    later = await _product(async_client, db_session, "Crate", "P1S", 2 * H)
    sooner = await _product(async_client, db_session, "Tag", "P1S", 1 * H)
    await _order(async_client, later.id, 1, timedelta(days=3), connected)
    await _order(async_client, sooner.id, 1, timedelta(days=1), connected)
    assert later.id < sooner.id

    calls, spy = _spy()
    online, status = _live(connected)
    with spy, online, status:
        done = await base_sync.replan_products(
            db_session, {later.id, sooner.id}, await base_sync.read_config(db_session)
        )
    assert done is not None and sorted(done.outcomes) == sorted([later.id, sooner.id])
    assert [product_id for product_id, _ in calls] == [sooner.id, later.id]


async def test_jobs_that_wait_for_start_are_planned_from_when_someone_is_there(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products
    from backend.app.services.staffed_hours import PlateTurnaround

    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", "P1S", 1 * H)
    await _order(async_client, tag.id, 1, timedelta(days=1), connected)
    morning = (datetime.now(timezone.utc) + timedelta(hours=10)).replace(microsecond=0)

    online, status = _live(connected)
    with online, status, patch.object(PlateTurnaround, "someone_there", lambda self: (morning, "unstaffed")):
        automatic = await products.replan(db_session, tag.id, actor_id=None, manual_start=False)
        assert automatic.plan.plates[0].start < morning - timedelta(hours=9)
        manual = await products.replan(db_session, tag.id, actor_id=None, manual_start=True)
    [plate] = manual.plan.plates
    assert plate.start >= morning


async def _waiting_tags(async_client: AsyncClient, db_session, printer_factory, quantity: int):
    printer = await printer_factory(name="P1S-A", model="P1S")
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", "P1S", 1 * H)
    await _order(async_client, tag.id, quantity, timedelta(days=1), connected)
    items = await _items(db_session, tag.file)
    assert len(items) == quantity
    return tag, connected, items


async def test_a_job_that_starts_while_the_plan_is_made_is_planned_around(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products

    tag, connected, items = await _waiting_tags(async_client, db_session, printer_factory, 2)
    started = items[0]
    real = products._run_planner
    tries = []

    async def scheduler_starts_one(inputs):
        if not tries:
            # The scheduler claims a job while the planner thinks.
            started.dispatching_at = datetime.now(timezone.utc)
            await db_session.flush()
        tries.append(inputs)
        return await real(inputs)

    online, status = _live(connected)
    with online, status, patch.object(products, "_run_planner", side_effect=scheduler_starts_one):
        outcome = await products.replan(db_session, tag.id, actor_id=None)
    await db_session.commit()
    # Planned again from the state then: the started job counts as printing.
    assert len(tries) == 2
    assert await db_session.get(PrintQueueItem, started.id) is not None
    job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == started.id))).scalar_one()
    assert job.status == "printing"
    assert outcome.kept + len(outcome.item_ids) == 1


async def test_jobs_that_keep_starting_while_planning_are_never_touched(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products

    tag, connected, items = await _waiting_tags(async_client, db_session, printer_factory, 3)
    real = products._run_planner
    tries = []

    async def scheduler_starts_one_each_time(inputs):
        # Every try sees one more job claimed; the last try carries on.
        items[len(tries)].dispatching_at = datetime.now(timezone.utc)
        await db_session.flush()
        tries.append(inputs)
        return await real(inputs)

    online, status = _live(connected)
    with online, status, patch.object(products, "_run_planner", side_effect=scheduler_starts_one_each_time):
        await products.replan(db_session, tag.id, actor_id=None)
    await db_session.commit()
    assert len(tries) == products.PLAN_TRIES
    ids = [item.id for item in items]
    db_session.expire_all()
    for item_id in ids:
        row = await db_session.get(PrintQueueItem, item_id)
        assert row is not None and row.status == "pending" and row.dispatching_at is not None
        job = (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == item_id))).scalar_one()
        assert job.status in ("planned", "printing")
