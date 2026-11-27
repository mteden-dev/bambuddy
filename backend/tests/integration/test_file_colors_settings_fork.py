"""The "always ask for the colours in the file" setting is saved and read back (fork).

See services/file_colors.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_off_until_switched_on(async_client: AsyncClient):
    response = await async_client.get("/api/v1/settings/")
    assert response.status_code == 200
    assert response.json()["require_file_colors"] is False

    response = await async_client.put("/api/v1/settings/", json={"require_file_colors": True})
    assert response.status_code == 200, response.text
    assert response.json()["require_file_colors"] is True
    assert (await async_client.get("/api/v1/settings/")).json()["require_file_colors"] is True

    response = await async_client.put("/api/v1/settings/", json={"require_file_colors": False})
    assert response.json()["require_file_colors"] is False


async def test_a_null_does_not_switch_it_off(async_client: AsyncClient):
    await async_client.put("/api/v1/settings/", json={"require_file_colors": True})
    response = await async_client.put("/api/v1/settings/", json={"require_file_colors": None})
    assert response.status_code in (200, 422)
    assert (await async_client.get("/api/v1/settings/")).json()["require_file_colors"] is True
