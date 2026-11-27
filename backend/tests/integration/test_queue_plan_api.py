"""POST /queue/plan applies the timeline's plan; reserved jobs wait for their printer (fork).

See services/queue_plan.py and services/queue_reservations.py.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.queue_reservations import QueueReservation
from backend.app.models.settings import Settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _item(db_session, archive_id: int, position: int, **extra) -> int:
    item = PrintQueueItem(archive_id=archive_id, status="pending", position=position, print_time_seconds=3600, **extra)
    db_session.add(item)
    await db_session.commit()
    return item.id


def _live(connected: set[int], printing: dict[int, int] | None = None):
    printing = printing or {}

    def status(printer_id: int):
        if printer_id in printing:
            return SimpleNamespace(state="RUNNING", remaining_time=printing[printer_id], progress=50)
        return SimpleNamespace(state="IDLE", remaining_time=0, progress=0)

    from backend.app.services.printer_manager import printer_manager

    return (
        patch.object(printer_manager, "is_connected", side_effect=lambda pid: pid in connected),
        patch.object(printer_manager, "get_status", side_effect=status),
    )


@pytest.fixture
async def farm(db_session, printer_factory, archive_factory):
    """Printers A and B (P1S, both free) and an X1C; three "Any P1S" jobs, an hour each."""
    a = await printer_factory(name="P1S-A", model="P1S")
    b = await printer_factory(name="P1S-B", model="P1S")
    x1c = await printer_factory(name="X1C", model="X1C")
    ids = SimpleNamespace(a=a.id, b=b.id, x1c=x1c.id)
    archive_id = (await archive_factory(ids.a, sliced_for_model="P1S")).id
    ids.archive = archive_id
    ids.j1 = await _item(db_session, archive_id, 1, target_model="P1S")
    ids.j2 = await _item(db_session, archive_id, 2, target_model="P1S")
    ids.j3 = await _item(db_session, archive_id, 3, target_model="P1S")
    return ids


async def _forecast(client: AsyncClient, connected: set[int]):
    online, status = _live(connected)
    with online, status:
        response = await client.get("/api/v1/queue/forecast")
    assert response.status_code == 200, response.text
    return response.json()


def _lanes(body) -> dict[int, list[int]]:
    lanes: dict[int, list[int]] = {}
    for p in sorted(body["placements"], key=lambda p: p["start"]):
        lanes.setdefault(p["printer_id"], []).append(p["item_id"])
    return lanes


async def _apply(client: AsyncClient, connected: set[int], lanes: dict[int, list[int]], reserve: list[int]):
    online, status = _live(connected)
    with online, status:
        return await client.post(
            "/api/v1/queue/plan",
            json={
                "lanes": [{"printer_id": pid, "item_ids": ids} for pid, ids in lanes.items()],
                "reserve": reserve,
            },
        )


async def test_a_moved_job_is_held_for_its_printer_and_the_rest_stay_put(async_client: AsyncClient, farm):
    connected = {farm.a, farm.b}
    before = _lanes(await _forecast(async_client, connected))
    assert before == {farm.a: [farm.j1, farm.j3], farm.b: [farm.j2]}

    # The last job goes first on B, ahead of the one B was going to print.
    response = await _apply(async_client, connected, {farm.a: [farm.j1], farm.b: [farm.j3, farm.j2]}, [farm.j3])

    assert response.status_code == 200, response.text
    body = response.json()
    assert farm.j3 in body["reserved"]
    assert body["moved_elsewhere"] == []
    after = await _forecast(async_client, connected)
    assert _lanes(after) == {farm.a: [farm.j1], farm.b: [farm.j3, farm.j2]}
    assert after["reservations"][str(farm.j3)] == {
        "printer_id": farm.b,
        "active": True,
        "source": "user",
        "soft": False,
        "placed": True,
    }
    reserved = {p["item_id"] for p in after["placements"] if p["reserved"]}
    assert farm.j3 in reserved and farm.j1 not in reserved


async def test_a_job_another_printer_would_take_is_held_too(async_client: AsyncClient, farm):
    connected = {farm.a, farm.b}
    # A is left with one job, B gets the other two: A would be free first and
    # take the last one, so it is held for B as well.
    response = await _apply(async_client, connected, {farm.a: [farm.j1], farm.b: [farm.j2, farm.j3]}, [farm.j2])

    assert response.status_code == 200, response.text
    assert sorted(response.json()["reserved"]) == sorted([farm.j2, farm.j3])
    assert _lanes(await _forecast(async_client, connected)) == {farm.a: [farm.j1], farm.b: [farm.j2, farm.j3]}


async def test_the_scheduler_order_follows_the_plan(async_client: AsyncClient, db_session, farm):
    connected = {farm.a, farm.b}
    await _apply(async_client, connected, {farm.a: [farm.j3], farm.b: [farm.j2, farm.j1]}, [farm.j3, farm.j2])

    rows = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status == "pending"))).scalars().all()
    by_position = [item.id for item in sorted(rows, key=lambda item: item.position)]
    # j3 and j2 start together (A before B in the pick order), then j1.
    assert by_position == [farm.j3, farm.j2, farm.j1]


async def test_a_job_cannot_be_held_for_a_printer_of_another_model(async_client: AsyncClient, farm):
    connected = {farm.a, farm.b, farm.x1c}
    response = await _apply(async_client, connected, {farm.x1c: [farm.j1]}, [farm.j1])

    assert response.status_code == 400
    assert "model" in response.json()["detail"]


async def test_not_while_shortest_job_first_orders_the_queue(async_client: AsyncClient, db_session, farm):
    db_session.add(Settings(key="queue_shortest_first", value="true"))
    await db_session.commit()

    response = await _apply(async_client, {farm.a}, {farm.a: [farm.j1]}, [])

    assert response.status_code == 409


async def test_releasing_hands_the_job_back_to_any_printer(async_client: AsyncClient, db_session, farm):
    connected = {farm.a, farm.b}
    await _apply(async_client, connected, {farm.a: [farm.j1], farm.b: [farm.j3, farm.j2]}, [farm.j3])

    response = await async_client.delete(f"/api/v1/queue/{farm.j3}/reservation")

    assert response.status_code == 200, response.text
    assert response.json() == {"released": True}
    assert str(farm.j3) not in (await _forecast(async_client, connected))["reservations"]


async def test_pinning_the_job_ends_its_reservation(async_client: AsyncClient, db_session, farm):
    connected = {farm.a, farm.b}
    await _apply(async_client, connected, {farm.a: [farm.j1], farm.b: [farm.j3, farm.j2]}, [farm.j3])

    response = await async_client.patch(f"/api/v1/queue/{farm.j3}", json={"printer_id": farm.a, "target_model": None})

    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert await db_session.get(QueueReservation, farm.j3) is None


async def test_the_printer_cards_list_shows_a_reserved_job_only_on_its_printer(async_client: AsyncClient, farm):
    connected = {farm.a, farm.b}
    await _apply(async_client, connected, {farm.a: [farm.j1], farm.b: [farm.j3, farm.j2]}, [farm.j3])

    online, status = _live(connected)
    with online, status:
        on_a = (await async_client.get(f"/api/v1/queue/?printer_id={farm.a}")).json()
        on_b = (await async_client.get(f"/api/v1/queue/?printer_id={farm.b}")).json()

    assert farm.j3 not in {item["id"] for item in on_a}
    assert farm.j3 in {item["id"] for item in on_b}


async def test_holding_a_job_the_product_planner_reserved_makes_the_hold_someones(
    async_client: AsyncClient, db_session, farm
):
    from backend.app.services.queue_reservations import SOURCE_PLAN, SOURCE_USER, reserve

    await reserve(db_session, await db_session.get(PrintQueueItem, farm.j3), farm.b, source=SOURCE_PLAN)
    await db_session.commit()

    response = await _apply(async_client, {farm.a, farm.b}, {farm.a: [farm.j1], farm.b: [farm.j3, farm.j2]}, [farm.j3])

    assert response.status_code == 200, response.text
    db_session.expire_all()
    row = await db_session.get(QueueReservation, farm.j3)
    assert (row.printer_id, row.source) == (farm.b, SOURCE_USER)


async def test_a_job_the_product_planner_holds_softly_and_the_user_left_alone_keeps_that_hold(
    async_client: AsyncClient, db_session, farm
):
    from backend.app.services.queue_reservations import SOURCE_PLAN, SOURCE_USER, reserve

    # The planner holds j3 for B, which prints for five more hours.
    await reserve(db_session, await db_session.get(PrintQueueItem, farm.j3), farm.b, source=SOURCE_PLAN)
    await db_session.commit()

    # The user moves j2 onto B and leaves j3 where it was. Replayed, A frees up
    # first and takes j3, which the planner's hold lets go: it stays the planner's.
    online, status = _live({farm.a, farm.b}, {farm.b: 300})
    with online, status:
        response = await async_client.post(
            "/api/v1/queue/plan",
            json={
                "lanes": [
                    {"printer_id": farm.a, "item_ids": [farm.j1]},
                    {"printer_id": farm.b, "item_ids": [farm.j2, farm.j3]},
                ],
                "reserve": [farm.j2],
            },
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reserved"] == [farm.j2]
    assert farm.j3 in body["moved_elsewhere"]
    db_session.expire_all()
    rows = (await db_session.execute(select(QueueReservation))).scalars()
    assert {row.queue_item_id: (row.printer_id, row.source) for row in rows} == {
        farm.j2: (farm.b, SOURCE_USER),
        farm.j3: (farm.b, SOURCE_PLAN),
    }


async def test_releasing_the_planners_hold_sticks_until_someone_holds_the_job(
    async_client: AsyncClient, db_session, farm
):
    from backend.app.services.queue_reservations import SOURCE_PLAN, SOURCE_RELEASED, SOURCE_USER, reserve

    await reserve(db_session, await db_session.get(PrintQueueItem, farm.j3), farm.b, source=SOURCE_PLAN)
    await db_session.commit()

    response = await async_client.delete(f"/api/v1/queue/{farm.j3}/reservation")

    assert response.status_code == 200, response.text
    assert response.json() == {"released": True}
    assert str(farm.j3) not in (await _forecast(async_client, {farm.a, farm.b}))["reservations"]
    # The planner's next replan holds every job it keeps again: not this one.
    db_session.expire_all()
    await reserve(db_session, await db_session.get(PrintQueueItem, farm.j3), farm.b, source=SOURCE_PLAN)
    await db_session.commit()
    assert (await db_session.get(QueueReservation, farm.j3)).source == SOURCE_RELEASED
    assert str(farm.j3) not in (await _forecast(async_client, {farm.a, farm.b}))["reservations"]

    # Moved by hand on the timeline, it is the user's.
    response = await _apply(async_client, {farm.a, farm.b}, {farm.a: [farm.j1, farm.j2], farm.b: [farm.j3]}, [farm.j3])
    assert response.status_code == 200, response.text
    db_session.expire_all()
    row = await db_session.get(QueueReservation, farm.j3)
    assert (row.printer_id, row.source) == (farm.b, SOURCE_USER)
    entry = (await _forecast(async_client, {farm.a, farm.b}))["reservations"][str(farm.j3)]
    assert (entry["source"], entry["soft"]) == ("user", False)


async def test_the_printer_cards_list_shows_a_job_whose_planner_hold_gives_way_on_the_others(
    async_client: AsyncClient, db_session, farm
):
    from backend.app.services.queue_reservations import SOURCE_PLAN, reserve

    await reserve(db_session, await db_session.get(PrintQueueItem, farm.j3), farm.b, source=SOURCE_PLAN)
    await db_session.commit()

    async def shown(printing):
        online, status = _live({farm.a, farm.b}, printing)
        result = set()
        with online, status:
            for pid in (farm.a, farm.b):
                listed = (await async_client.get(f"/api/v1/queue/?printer_id={pid}")).json()
                if farm.j3 in {item["id"] for item in listed}:
                    result.add(pid)
        return result

    # B is busy for five hours: A will get the job, so its card lists it.
    assert await shown({farm.b: 300}) == {farm.a, farm.b}
    # B is done in ten minutes: the job waits for it.
    assert await shown({farm.b: 10}) == {farm.b}
