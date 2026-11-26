"""Filament aliases API: save colour and profile groups, see what the queue asks for (fork).

See services/filament_aliases.py and api/routes/filament_aliases.py.
"""

from __future__ import annotations

import json

import pytest
from httpx import AsyncClient

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import filament_aliases

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


@pytest.fixture(autouse=True)
def no_groups():
    filament_aliases.apply(filament_aliases.Aliases())
    yield
    filament_aliases.apply(filament_aliases.Aliases())


async def test_groups_are_saved_cleaned_and_used_at_once(async_client: AsyncClient, db_session):
    empty = (await async_client.get("/api/v1/filament-aliases")).json()
    assert (empty["colors"], empty["presets"]) == ([], [])

    response = await async_client.put(
        "/api/v1/filament-aliases",
        json={
            "colors": [["#DCDB4E", "#E2DF60"], ["#E2DF60", "#F0E68C"], ["#000000"]],
            "presets": [["GFG99", "P1a2b3c4"]],
        },
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["colors"] == [["dcdb4e", "e2df60", "f0e68c"]]
    assert saved["presets"] == [["GFG99", "P1a2b3c4"]]
    # The queue's matching goes by them straight away.
    assert filament_aliases.preset("P1a2b3c4") == "GFG99"
    assert filament_aliases.color("f0e68c") == "dcdb4e"

    # And they are what the next start reads.
    filament_aliases.apply(filament_aliases.Aliases())
    await filament_aliases.refresh(db_session)
    assert filament_aliases.preset("P1a2b3c4") == "GFG99"
    assert (await async_client.get("/api/v1/filament-aliases")).json()["presets"] == [["GFG99", "P1a2b3c4"]]


async def test_the_colours_and_profiles_waiting_jobs_ask_for_are_suggested(async_client: AsyncClient, db_session):
    overrides = [
        {"slot_id": 1, "type": "PETG", "color": "#E2DF60", "tray_info_idx": "GFG99", "force_color_match": True}
    ]
    db_session.add(PrintQueueItem(status="pending", position=1, filament_overrides=json.dumps(overrides)))
    db_session.add(
        PrintQueueItem(
            status="completed",
            position=2,
            filament_overrides=json.dumps(
                [{"slot_id": 1, "type": "PLA", "color": "#123456", "tray_info_idx": "GFA00", "force_color_match": True}]
            ),
        )
    )
    await db_session.commit()

    got = (await async_client.get("/api/v1/filament-aliases")).json()
    assert got["seen_colors"] == [{"color": "e2df60", "types": ["PETG"], "where": ["queue"]}]
    assert got["seen_presets"] == [{"preset": "GFG99", "types": ["PETG"], "names": [], "where": ["queue"]}]


async def test_a_group_too_large_is_refused(async_client: AsyncClient):
    response = await async_client.put(
        "/api/v1/filament-aliases", json={"colors": [["#000000", "#111111"]] * 101, "presets": []}
    )
    assert response.status_code == 422
