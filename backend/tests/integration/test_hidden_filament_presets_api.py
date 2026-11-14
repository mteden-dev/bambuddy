"""Saving and reading the AMS slot picker's hidden filament presets."""

import json

import pytest
from httpx import AsyncClient

FLAGS_URL = "/api/v1/settings/ui-flags"


class TestHiddenFilamentPresetsApi:
    @pytest.mark.asyncio
    async def test_round_trip_through_settings_and_ui_flags(self, async_client: AsyncClient):
        hidden = json.dumps(["builtin_GFB00", "local_2", "GFSL05_09"])
        update = await async_client.put(
            "/api/v1/settings/",
            json={"hidden_filament_presets": hidden, "hide_builtin_filament_presets": True},
        )
        assert update.status_code == 200
        assert update.json()["hidden_filament_presets"] == hidden
        assert update.json()["hide_builtin_filament_presets"] is True

        # Users without settings:read build the picker from /ui-flags, so the
        # same values (and the flag as a real bool) must be served there.
        flags = (await async_client.get(FLAGS_URL)).json()
        assert flags["hidden_filament_presets"] == hidden
        assert flags["hide_builtin_filament_presets"] is True

        full = (await async_client.get("/api/v1/settings/")).json()
        assert full["hidden_filament_presets"] == hidden
        assert full["hide_builtin_filament_presets"] is True

    @pytest.mark.asyncio
    async def test_not_served_to_anonymous_callers(self, async_client: AsyncClient):
        """The IDs include private cloud and local presets: they describe this
        install, so they stay off the endpoint that answers anyone."""
        public = (await async_client.get("/api/v1/settings/ui-preferences")).json()
        assert "hidden_filament_presets" not in public
        assert "hide_builtin_filament_presets" not in public

    @pytest.mark.asyncio
    async def test_flag_can_be_turned_back_off(self, async_client: AsyncClient):
        await async_client.put("/api/v1/settings/", json={"hide_builtin_filament_presets": True})
        update = await async_client.put("/api/v1/settings/", json={"hide_builtin_filament_presets": False})
        assert update.status_code == 200
        flags = (await async_client.get(FLAGS_URL)).json()
        assert flags["hide_builtin_filament_presets"] is False

    @pytest.mark.asyncio
    async def test_rejects_a_malformed_list(self, async_client: AsyncClient):
        response = await async_client.put("/api/v1/settings/", json={"hidden_filament_presets": "builtin_GFB00"})
        assert response.status_code == 422
