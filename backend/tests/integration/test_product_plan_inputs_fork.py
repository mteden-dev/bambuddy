"""What a product plan is made from and leaves behind (fork).

The planner's holds are its own and yield, jobs held for filament take lane
time, and plates print as long as their history says. See services/products.py
(``replan``), services/queue_reservations.py and services/plate_history.py.
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
from backend.app.models.products import ProductJob, ProductPlate
from backend.app.models.queue_reservations import QueueReservation
from backend.app.models.settings import Settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

H = 3600


def _live(connected: set[int]):
    from backend.app.services.printer_manager import printer_manager

    idle = SimpleNamespace(state="IDLE", remaining_time=0, progress=0)
    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=lambda pid: idle),
    )


async def _product(client: AsyncClient, db_session, name: str, seconds: int) -> SimpleNamespace:
    """A product of one loose part, one piece per plate, sliced for the P1S."""
    f = LibraryFile(
        filename=f"{name}.gcode.3mf",
        file_path=f"/test/{name}.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={"sliced_for_model": "P1S", "print_time_seconds": seconds, "printable_objects": {"1": name}},
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
    product_id = response.json()["id"]
    plate = (await db_session.execute(select(ProductPlate).where(ProductPlate.product_id == product_id))).scalar_one()
    return SimpleNamespace(id=product_id, file=f.id, plate=plate.id)


async def _order(client: AsyncClient, product_id: int, quantity: int, connected: set[int]) -> dict:
    due = datetime.now(timezone.utc) + timedelta(days=2)
    online, status = _live(connected)
    with online, status:
        response = await client.post(
            f"/api/v1/products/{product_id}/orders", json={"quantity": quantity, "due_date": due.isoformat()}
        )
    assert response.status_code == 200, response.text
    return response.json()


async def _waiting(db_session, library_file_id: int) -> list[PrintQueueItem]:
    db_session.expire_all()
    rows = await db_session.execute(
        select(PrintQueueItem)
        .where(PrintQueueItem.status == "pending", PrintQueueItem.library_file_id == library_file_id)
        .order_by(PrintQueueItem.position)
    )
    return list(rows.scalars())


async def _job_of(db_session, item_id: int) -> ProductJob:
    return (await db_session.execute(select(ProductJob).where(ProductJob.queue_item_id == item_id))).scalar_one()


# --- the planner's holds ------------------------------------------------------------------


async def test_a_planned_loose_plate_is_held_softly_by_the_planner(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services.queue_forecast import load_forecast_inputs

    printer = SimpleNamespace(id=(await printer_factory(name="P1S-A", model="P1S")).id)
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", H)
    await _order(async_client, tag.id, 1, connected)
    [item] = await _waiting(db_session, tag.file)
    assert item.printer_id is None and item.target_model == "P1S"

    row = await db_session.get(QueueReservation, item.id)
    assert (row.printer_id, row.source) == (printer.id, "plan")
    online, status = _live(connected)
    with online, status:
        inputs = await load_forecast_inputs(db_session)
    job = inputs.jobs[item.id]
    assert job.reserved_printer_id == printer.id
    assert job.reservation_soft is True


async def test_planned_again_a_job_someone_held_on_its_printer_stays_theirs(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products
    from backend.app.services.queue_reservations import SOURCE_USER, reserve

    printer = SimpleNamespace(id=(await printer_factory(name="P1S-A", model="P1S")).id)
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", H)
    await _order(async_client, tag.id, 1, connected)
    [item] = await _waiting(db_session, tag.file)
    item_id = item.id
    # The timeline's plan holds it on the very printer the planner chose.
    await reserve(db_session, item, printer.id, source=SOURCE_USER)
    await db_session.commit()

    online, status = _live(connected)
    with online, status:
        outcome = await products.replan(db_session, tag.id, actor_id=None)
    await db_session.commit()
    # Not a move by hand: the job is kept, and the hold is still someone's.
    assert (outcome.kept, outcome.held, outcome.item_ids) == (1, 0, [])
    db_session.expire_all()
    assert (await db_session.get(QueueReservation, item_id)).source == "user"


# --- jobs held for filament ------------------------------------------------------------------


async def test_a_job_held_for_filament_takes_its_lane_before_the_plan(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products
    from backend.app.services.staffed_hours import PlateTurnaround

    printer = SimpleNamespace(id=(await printer_factory(name="P1S-A", model="P1S")).id)
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", H)
    other = LibraryFile(
        filename="Crate.gcode.3mf",
        file_path="/test/Crate.gcode.3mf",
        file_size=100,
        file_type="3mf",
        file_metadata={"sliced_for_model": "P1S", "print_time_seconds": 3 * H},
    )
    db_session.add(other)
    await db_session.commit()
    db_session.add(
        PrintQueueItem(
            library_file_id=other.id,
            printer_id=printer.id,
            status="pending",
            position=1,
            print_time_seconds=3 * H,
            waiting_reason="Waiting for filament: P1S-A (needs PETG)",
        )
    )
    await db_session.commit()
    await _order(async_client, tag.id, 1, connected)
    now = datetime.now(timezone.utc).replace(microsecond=0)

    online, status = _live(connected)
    with online, status, patch.object(PlateTurnaround, "someone_there", lambda self: (now, "staffed")):
        outcome = await products.replan(db_session, tag.id, actor_id=None)
    [plate] = outcome.plan.plates
    assert plate.printer_id == printer.id
    # Someone loads the PETG (the swap minutes), the crate prints 3 h, then the tag.
    swap = (await products.read_plan_settings(db_session)).swap_minutes * 60
    assert plate.start >= now + timedelta(seconds=swap + 3 * H)


# --- learned print times -------------------------------------------------------------------


async def _printed(db_session, product, printer_id: int, real_s: int, days_ago: float, **job) -> ProductJob:
    """A finished run of the product's plate: its queue job and its job."""
    end = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
    created = end - timedelta(seconds=real_s + 600)
    item = PrintQueueItem(
        library_file_id=product.file,
        printer_id=printer_id,
        status="completed",
        position=0,
        print_time_seconds=job.pop("item_estimate", H),
        created_at=created,
        started_at=end - timedelta(seconds=real_s),
        completed_at=end,
    )
    db_session.add(item)
    await db_session.flush()
    row = ProductJob(
        product_id=product.id,
        product_plate_id=product.plate,
        queue_item_id=item.id,
        item_created_at=created,
        printer_id=printer_id,
        status="done",
        pieces={},
        finished_at=end,
        **job,
    )
    db_session.add(row)
    await db_session.commit()
    return row


async def test_a_plate_with_history_is_planned_with_its_learned_time(
    async_client: AsyncClient, db_session, printer_factory
):
    from backend.app.services import products
    from backend.app.services.plate_history import load_plate_history

    printer = SimpleNamespace(id=(await printer_factory(name="P1S-A", model="P1S")).id)
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", H)
    # Runs from before the planner recorded the estimate: their queue jobs carry the slicer's.
    for k, real in enumerate((3900, 4000, 4100)):
        await _printed(db_session, tag, printer.id, real, days_ago=k + 2)

    await _order(async_client, tag.id, 1, connected)
    [item] = await _waiting(db_session, tag.file)
    # The queue job carries the time the plan used; the job keeps the slicer's.
    assert item.print_time_seconds == 4000
    job = await _job_of(db_session, item.id)
    assert job.plan_info["estimate_s"] == H

    # That job prints, in 4400 s: its run counts though its queue job says 4000.
    end = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
    item.status = "completed"
    item.started_at = end - timedelta(seconds=4400)
    item.completed_at = end
    job.status = "done"
    job.finished_at = end
    await db_session.commit()
    plate = await db_session.get(ProductPlate, tag.plate)
    history = await load_plate_history(db_session, [plate], {tag.plate: H})
    assert history[tag.plate].runs == 4
    assert history[tag.plate].duration_s == 4050

    # Planned again, the next job takes the new time.
    await _order(async_client, tag.id, 1, connected)
    [item] = await _waiting(db_session, tag.file)
    item_id = item.id
    assert item.print_time_seconds == 4050
    assert (await _job_of(db_session, item_id)).plan_info["estimate_s"] == H
    # A kept job takes a changed time too.
    await _printed(db_session, tag, printer.id, 4600, days_ago=0.5, plan_info={"estimate_s": H})
    online, status = _live(connected)
    with online, status:
        outcome = await products.replan(db_session, tag.id, actor_id=None)
    await db_session.commit()
    assert outcome.kept == 1
    db_session.expire_all()
    assert (await db_session.get(PrintQueueItem, item_id)).print_time_seconds == 4100


async def test_with_learning_off_the_slicer_s_time_is_used(async_client: AsyncClient, db_session, printer_factory):
    from backend.app.services import products

    printer = SimpleNamespace(id=(await printer_factory(name="P1S-A", model="P1S")).id)
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", H)
    for k in range(3):
        await _printed(db_session, tag, printer.id, 4000, days_ago=k + 2, item_estimate=H)
    db_session.add(Settings(key=products.LEARN_HISTORY_KEY, value="false"))
    await db_session.commit()
    assert (await products.read_plan_settings(db_session)).learn_history is False
    await _order(async_client, tag.id, 1, connected)

    online, status = _live(connected)
    with online, status:
        outcome = await products.replan(db_session, tag.id, actor_id=None)
    await db_session.commit()
    [plate] = outcome.plan.plates
    assert (plate.option.duration_s, plate.option.risk) == (H, 0.0)
    [item] = await _waiting(db_session, tag.file)
    assert item.print_time_seconds == H
    assert (await _job_of(db_session, item.id)).plan_info["estimate_s"] == H


async def test_a_file_without_a_print_time_records_no_estimate(async_client: AsyncClient, db_session, printer_factory):
    from backend.app.services import products

    printer = SimpleNamespace(id=(await printer_factory(name="P1S-A", model="P1S")).id)
    connected = {printer.id}
    tag = await _product(async_client, db_session, "Tag", 0)
    await _order(async_client, tag.id, 1, connected)
    [item] = await _waiting(db_session, tag.file)
    assert item.print_time_seconds == products.DEFAULT_DURATION_S
    assert "estimate_s" not in (await _job_of(db_session, item.id)).plan_info
