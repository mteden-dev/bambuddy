"""Saving and reading the AMS slot picker's quick colours (ams_color_palette)."""

import json

import pytest
from httpx import AsyncClient

FLAGS_URL = "/api/v1/settings/ui-flags"


class TestAmsColorPaletteApi:
    @pytest.mark.asyncio
    async def test_round_trip_through_settings_and_ui_flags(self, async_client: AsyncClient):
        palette = json.dumps(
            [{"name": "Jade White", "hex": "FFFFFF"}, {"name": "Cyan", "hex": "00FFFF", "hidden": True}]
        )
        update = await async_client.put("/api/v1/settings/", json={"ams_color_palette": palette})
        assert update.status_code == 200
        assert update.json()["ams_color_palette"] == palette

        # Users without settings:read build the picker from /ui-flags.
        flags = (await async_client.get(FLAGS_URL)).json()
        assert flags["ams_color_palette"] == palette

    @pytest.mark.asyncio
    async def test_not_served_to_anonymous_callers(self, async_client: AsyncClient):
        """The names are typed on this install, so the palette stays off the
        endpoint that answers anyone."""
        public = (await async_client.get("/api/v1/settings/ui-preferences")).json()
        assert "ams_color_palette" not in public

    @pytest.mark.asyncio
    async def test_empty_restores_the_defaults(self, async_client: AsyncClient):
        await async_client.put(
            "/api/v1/settings/", json={"ams_color_palette": json.dumps([{"name": "Red", "hex": "FF0000"}])}
        )
        update = await async_client.put("/api/v1/settings/", json={"ams_color_palette": ""})
        assert update.status_code == 200
        assert update.json()["ams_color_palette"] == ""

    @pytest.mark.asyncio
    async def test_rejects_a_malformed_palette(self, async_client: AsyncClient):
        bad = json.dumps([{"name": "White", "hex": "#FFF"}])
        response = await async_client.put("/api/v1/settings/", json={"ams_color_palette": bad})
        assert response.status_code == 422
