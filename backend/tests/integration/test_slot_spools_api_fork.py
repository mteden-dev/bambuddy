"""Slot spool routes (fork, api/routes/slot_spools.py)."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.settings import Settings
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.services.slot_spools import record_refills

URL = "/api/v1/slot-spools"


def _body(printer_id: int, **overrides) -> dict:
    body = {
        "printer_id": printer_id,
        "ams_id": 0,
        "tray_id": 1,
        "material": "PLA",
        "rgba": "112233FF",
        "slicer_filament": "GFL99",
        "slicer_filament_name": "Generic PLA",
        "k_profile": {"cali_idx": 4, "k_value": 0.02, "extruder": 0, "nozzle_diameter": "0.4"},
    }
    body.update(overrides)
    return body


@pytest.mark.integration
class TestSlotSpoolRoutes:
    @pytest.mark.asyncio
    async def test_load_a_full_roll(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        resp = await async_client.post(URL, json=_body(printer.id))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert (data["ams_id"], data["tray_id"]) == (0, 1)
        assert data["spool"]["data_origin"] == "slot_quick"
        assert data["spool"]["label_weight"] == 1000
        assert data["spool"]["weight_used"] == 0
        assert [k["cali_idx"] for k in data["spool"]["k_profiles"]] == [4]

    @pytest.mark.asyncio
    async def test_unknown_printer(self, async_client: AsyncClient):
        resp = await async_client.post(URL, json=_body(9999))
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_spoolman_mode_refuses(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory()
        db_session.add(Settings(key="spoolman_enabled", value="true"))
        await db_session.commit()
        resp = await async_client.post(URL, json=_body(printer.id))
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_take_out_and_restore(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        loaded = (await async_client.post(URL, json=_body(printer.id, remaining_grams=420))).json()
        resp = await async_client.delete(f"/api/v1/inventory/assignments/{printer.id}/0/1")
        assert resp.status_code == 200

        restorable = (await async_client.get(f"{URL}/restorable", params={"material": "PLA"})).json()
        assert [(r["id"], r["remaining_grams"]) for r in restorable] == [(loaded["spool_id"], 420)]

        resp = await async_client.post(URL, json=_body(printer.id, tray_id=2, restore_spool_id=loaded["spool_id"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["spool"]["archived_at"] is None
        assert (await async_client.get(f"{URL}/restorable")).json() == []

    @pytest.mark.asyncio
    async def test_more_than_five_kilograms_is_refused(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        resp = await async_client.post(URL, json=_body(printer.id, remaining_grams=6500))
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_restorable_describes_the_roll_to_set_the_slot_back(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        other = await printer_factory()
        loaded = (await async_client.post(URL, json=_body(printer.id, material="PETG", remaining_grams=420))).json()
        await async_client.delete(f"/api/v1/inventory/assignments/{printer.id}/0/1")

        params = {"material": "PLA", "include_other": "true", "printer_id": printer.id}
        [roll] = (await async_client.get(f"{URL}/restorable", params=params)).json()
        assert roll["id"] == loaded["spool_id"]
        assert roll["material_match"] is False
        assert roll["slicer_filament"] == "GFL99"
        assert [(k["cali_idx"], k["extruder"], k["nozzle_diameter"]) for k in roll["k_profiles"]] == [(4, 0, "0.4")]
        # Another printer's calibration is not this printer's.
        params["printer_id"] = other.id
        assert (await async_client.get(f"{URL}/restorable", params=params)).json()[0]["k_profiles"] == []
        # Without include_other a PLA slot is not offered the PETG roll.
        assert (await async_client.get(f"{URL}/restorable", params={"material": "PLA"})).json() == []

    @pytest.mark.asyncio
    async def test_a_roll_in_another_slot_is_not_restored(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        loaded = (await async_client.post(URL, json=_body(printer.id))).json()
        resp = await async_client.post(URL, json=_body(printer.id, tray_id=2, restore_spool_id=loaded["spool_id"]))
        assert resp.status_code == 409
        assignments = (await async_client.get("/api/v1/inventory/assignments")).json()
        assert [(a["spool_id"], a["tray_id"]) for a in assignments] == [(loaded["spool_id"], 1)]

    @pytest.mark.asyncio
    async def test_same_roll_prompt(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory()
        await async_client.post(URL, json=_body(printer.id))
        await record_refills(db_session, printer.id, [(0, 1)])
        await db_session.commit()

        prompts = (await async_client.get(f"{URL}/prompts")).json()
        assert [(p["printer_id"], p["ams_id"], p["tray_id"]) for p in prompts] == [(printer.id, 0, 1)]

        resp = await async_client.post(f"{URL}/prompts/{printer.id}/0/1/same")
        assert resp.json() == {"status": "ok", "cleared": True}
        assert (await async_client.get(f"{URL}/prompts")).json() == []
        # The roll keeps counting on the same spool.
        assert len((await db_session.execute(select(SpoolAssignment))).scalars().all()) == 1
