"""Slot spools (fork, services/slot_spools.py).

A roll loaded into an AMS slot is counted on a ``slot_quick`` spool assigned to
the slot, without identifying the roll. Pinned here: loading, restoring and
archiving those spools, the "same roll?" prompt for a slot emptied and refilled
under its spool, and the filament check's per-slot and margin settings.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.models.slot_spool_prompt import SlotSpoolPrompt
from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.models.spool_k_profile import SpoolKProfile
from backend.app.services import slot_spools
from backend.app.services.filament_deficit import compute_deficit_for_queue_item
from backend.app.services.slot_spools import (
    SLOT_SPOOL_ORIGIN,
    CheckSettings,
    KProfileChoice,
    SlotSpoolError,
    SlotSpoolLoad,
    clear_prompt,
    drop_prompts,
    list_prompts,
    load_check_settings,
    load_slot_spool,
    parse_margin_pct,
    presence_changes,
    record_refills,
    restorable_spools,
)


@pytest.fixture(autouse=True)
def _fresh_presence():
    slot_spools.reset()
    yield
    slot_spools.reset()


def _unit(ams_id: int, present: dict[int, bool | None]) -> dict:
    trays = []
    for tray_id, exists in present.items():
        tray = {"id": str(tray_id), "tray_type": "PLA" if exists else ""}
        if exists is not None:
            tray["exists"] = exists
        trays.append(tray)
    return {"id": str(ams_id), "tray": trays}


async def _load(db_session, printer_id: int, **overrides) -> SpoolAssignment:
    data = {
        "printer_id": printer_id,
        "ams_id": 0,
        "tray_id": 0,
        "material": "PLA",
        "rgba": "112233",
        "slicer_filament": "GFL99",
        "slicer_filament_name": "Generic PLA",
    }
    data.update(overrides)
    assignment = await load_slot_spool(db_session, SlotSpoolLoad(**data))
    await db_session.commit()
    return assignment


async def _spool_by_id(db_session, spool_id: int) -> Spool:
    result = await db_session.execute(
        select(Spool).where(Spool.id == spool_id).execution_options(populate_existing=True)
    )
    return result.scalar_one()


class TestPresenceChanges:
    def test_a_slot_going_full_then_empty_is_emptied(self):
        presence_changes(1, [_unit(0, {0: True, 1: True})])
        changes = presence_changes(1, [_unit(0, {0: False, 1: True})])
        assert changes.emptied == [(0, 0)]
        assert changes.refilled == []
        assert presence_changes(1, [_unit(0, {0: False, 1: True})]).emptied == []

    def test_a_whole_unit_blanking_at_once_empties_nothing(self):
        presence_changes(1, [_unit(0, {0: True, 1: True})])
        assert presence_changes(1, [_unit(0, {0: False, 1: False})]).emptied == []

    def test_a_slot_going_empty_then_full_is_a_refill(self):
        assert presence_changes(1, [_unit(0, {0: True, 1: True})]).refilled == []
        assert presence_changes(1, [_unit(0, {0: False, 1: True})]).refilled == []
        assert presence_changes(1, [_unit(0, {0: True, 1: True})]).refilled == [(0, 0)]

    def test_the_first_report_only_sets_the_baseline(self):
        assert presence_changes(1, [_unit(0, {0: True})]).refilled == []

    def test_a_slot_seen_empty_at_start_and_filled_counts(self):
        assert presence_changes(1, [_unit(0, {0: False})]).refilled == []
        assert presence_changes(1, [_unit(0, {0: True})]).refilled == [(0, 0)]

    def test_a_whole_unit_blanking_at_once_is_not_a_person(self):
        """#3186: an idle X1C blanked a whole unit for one push."""
        presence_changes(1, [_unit(0, {0: True, 1: True, 2: True})])
        assert presence_changes(1, [_unit(0, {0: False, 1: False, 2: False})]).refilled == []
        # The glitch report was skipped, so its return is no refill either.
        assert presence_changes(1, [_unit(0, {0: True, 1: True, 2: True})]).refilled == []

    def test_trays_without_a_presence_bit_are_left_out(self):
        presence_changes(1, [_unit(0, {0: None})])
        presence_changes(1, [_unit(0, {0: None})])
        assert presence_changes(1, [_unit(0, {0: None})]).refilled == []

    def test_printers_and_units_are_kept_apart(self):
        presence_changes(1, [_unit(0, {0: False}), _unit(1, {0: True})])
        presence_changes(2, [_unit(0, {0: True})])
        assert presence_changes(1, [_unit(0, {0: True}), _unit(1, {0: True})]).refilled == [(0, 0)]


class TestLoadSlotSpool:
    @pytest.mark.asyncio
    async def test_a_full_roll_is_one_kilogram_assigned_to_the_slot(self, db_session, printer_factory):
        printer = await printer_factory()
        assignment = await _load(
            db_session,
            printer.id,
            ams_id=1,
            tray_id=2,
            k_profile=KProfileChoice(cali_idx=7, k_value=0.021, extruder=0, nozzle_diameter="0.4", name="PLA K"),
        )

        spool = await _spool_by_id(db_session, assignment.spool_id)
        assert spool.data_origin == SLOT_SPOOL_ORIGIN
        assert spool.label_weight == 1000
        assert spool.weight_used == 0
        assert spool.added_full is True
        assert spool.rgba == "112233FF"
        assert spool.slicer_filament == "GFL99"
        assert (assignment.ams_id, assignment.tray_id) == (1, 2)
        # The fingerprint is what the slot was just configured with, so the
        # unlink pass reads the next AMS report as the same roll.
        assert assignment.fingerprint_type == "PLA"
        assert assignment.fingerprint_color == "112233FF"
        profiles = (await db_session.execute(select(SpoolKProfile))).scalars().all()
        assert [(p.spool_id, p.cali_idx, p.k_value) for p in profiles] == [(spool.id, 7, 0.021)]

    @pytest.mark.asyncio
    async def test_a_partial_roll_counts_from_what_is_on_it(self, db_session, printer_factory):
        printer = await printer_factory()
        assignment = await _load(db_session, printer.id, remaining_grams=420)
        spool = await _spool_by_id(db_session, assignment.spool_id)
        assert spool.label_weight - spool.weight_used == 420
        assert spool.added_full is False

    @pytest.mark.asyncio
    async def test_the_default_k_profile_is_not_stored(self, db_session, printer_factory):
        printer = await printer_factory()
        await _load(db_session, printer.id, k_profile=KProfileChoice(cali_idx=-1, k_value=0.02))
        assert (await db_session.execute(select(SpoolKProfile))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_loading_another_roll_archives_the_previous_one(self, db_session, printer_factory):
        printer = await printer_factory()
        first = await _load(db_session, printer.id, remaining_grams=300)
        first_spool_id = first.spool_id
        second = await _load(db_session, printer.id)

        old = await _spool_by_id(db_session, first_spool_id)
        assert old.archived_at is not None
        assert second.spool_id != first_spool_id
        assigned = (await db_session.execute(select(SpoolAssignment))).scalars().all()
        assert [a.spool_id for a in assigned] == [second.spool_id]

    @pytest.mark.asyncio
    async def test_unassigning_archives_a_slot_spool_only(self, db_session, printer_factory):
        printer = await printer_factory()
        slot = await _load(db_session, printer.id)
        slot_spool_id = slot.spool_id
        own = Spool(material="PLA", label_weight=1000, weight_used=0)
        db_session.add(own)
        await db_session.flush()
        own_assignment = SpoolAssignment(spool_id=own.id, printer_id=printer.id, ams_id=0, tray_id=1)
        db_session.add(own_assignment)
        await db_session.commit()

        await db_session.delete(slot)
        await db_session.delete(own_assignment)
        await db_session.commit()

        assert (await _spool_by_id(db_session, slot_spool_id)).archived_at is not None
        assert (await _spool_by_id(db_session, own.id)).archived_at is None

    @pytest.mark.asyncio
    async def test_restoring_brings_back_what_was_left(self, db_session, printer_factory):
        printer = await printer_factory()
        first = await _load(db_session, printer.id, remaining_grams=420)
        spool_id = first.spool_id
        await db_session.delete(first)
        await db_session.commit()
        assert (await _spool_by_id(db_session, spool_id)).archived_at is not None

        restored = await _load(db_session, printer.id, tray_id=3, restore_spool_id=spool_id, rgba="445566FF")

        spool = await _spool_by_id(db_session, spool_id)
        assert restored.spool_id == spool_id
        assert spool.archived_at is None
        assert spool.label_weight - spool.weight_used == 420
        # Describes the slot as configured now.
        assert spool.rgba == "445566FF"

    @pytest.mark.asyncio
    async def test_restoring_can_correct_the_amount(self, db_session, printer_factory):
        printer = await printer_factory()
        first = await _load(db_session, printer.id, remaining_grams=420)
        spool_id = first.spool_id
        await db_session.delete(first)
        await db_session.commit()

        await _load(db_session, printer.id, restore_spool_id=spool_id, remaining_grams=380)
        spool = await _spool_by_id(db_session, spool_id)
        assert spool.label_weight - spool.weight_used == 380

    @pytest.mark.asyncio
    async def test_restoring_the_roll_already_in_the_slot_keeps_it_active(self, db_session, printer_factory):
        """Replacing the slot's own spool with itself: the replace archives it
        on the connection, and the restore must still see that and undo it."""
        printer = await printer_factory()
        first = await _load(db_session, printer.id, remaining_grams=600)
        spool_id = first.spool_id

        await _load(db_session, printer.id, restore_spool_id=spool_id)

        assert (await _spool_by_id(db_session, spool_id)).archived_at is None
        assigned = (await db_session.execute(select(SpoolAssignment))).scalars().all()
        assert [a.spool_id for a in assigned] == [spool_id]

    @pytest.mark.asyncio
    async def test_only_a_slot_spool_can_be_restored(self, db_session, printer_factory):
        printer = await printer_factory()
        own = Spool(material="PLA", label_weight=1000, weight_used=0)
        db_session.add(own)
        await db_session.commit()
        with pytest.raises(SlotSpoolError) as exc:
            await load_slot_spool(
                db_session,
                SlotSpoolLoad(printer_id=printer.id, ams_id=0, tray_id=0, material="PLA", restore_spool_id=own.id),
            )
        assert exc.value.status_code == 400

    @pytest.mark.asyncio
    async def test_restorable_lists_matching_material_same_colour_first(self, db_session, printer_factory):
        printer = await printer_factory()
        rolls = []
        for tray, (material, rgba, grams) in enumerate(
            [("PLA", "FF0000", 300), ("PLA", "00FF00", 500), ("PETG", "00FF00", 500), ("PLA", "00FF00", 2)]
        ):
            a = await _load(db_session, printer.id, tray_id=tray, material=material, rgba=rgba, remaining_grams=grams)
            rolls.append(a.spool_id)
        for a in (await db_session.execute(select(SpoolAssignment))).scalars().all():
            await db_session.delete(a)
        await db_session.commit()

        found = await restorable_spools(db_session, material="PLA", rgba="00FF00FF")
        # PETG left out, the nearly empty roll too; green before red.
        assert [s.id for s in found] == [rolls[1], rolls[0]]

    @pytest.mark.asyncio
    async def test_more_than_five_kilograms_is_refused(self, db_session, printer_factory):
        """A typo (6500 for 650) would count for months before anyone noticed."""
        printer = await printer_factory()
        with pytest.raises(SlotSpoolError) as exc:
            await load_slot_spool(
                db_session,
                SlotSpoolLoad(printer_id=printer.id, ams_id=0, tray_id=0, material="PLA", remaining_grams=6500),
            )
        assert exc.value.status_code == 422

    @pytest.mark.asyncio
    async def test_a_roll_counting_in_another_slot_is_not_restored(self, db_session, printer_factory):
        """A stale restore list offered it; taking it out of that slot silently
        would leave the roll there uncounted."""
        printer = await printer_factory()
        first = await _load(db_session, printer.id, tray_id=1, remaining_grams=420)
        spool_id = first.spool_id
        with pytest.raises(SlotSpoolError) as exc:
            await load_slot_spool(
                db_session,
                SlotSpoolLoad(printer_id=printer.id, ams_id=0, tray_id=2, material="PLA", restore_spool_id=spool_id),
            )
        assert exc.value.status_code == 409
        await db_session.rollback()
        assigned = (await db_session.execute(select(SpoolAssignment))).scalars().all()
        assert [(a.spool_id, a.tray_id) for a in assigned] == [(spool_id, 1)]

    @pytest.mark.asyncio
    async def test_restorable_can_list_other_types_after_the_matching_ones(self, db_session, printer_factory):
        printer = await printer_factory()
        rolls = []
        for tray, (material, rgba) in enumerate([("PETG", "00FF00"), ("PLA", "FF0000"), ("PLA", "00FF00")]):
            a = await _load(
                db_session,
                printer.id,
                tray_id=tray,
                material=material,
                rgba=rgba,
                remaining_grams=500,
                k_profile=KProfileChoice(cali_idx=tray + 3, k_value=0.02),
            )
            rolls.append(a.spool_id)
        for a in (await db_session.execute(select(SpoolAssignment))).scalars().all():
            await db_session.delete(a)
        await db_session.commit()

        found = await restorable_spools(db_session, material="PLA", rgba="00FF00FF", include_other=True)
        # PLA first (green before red), then the PETG roll.
        assert [s.id for s in found] == [rolls[2], rolls[1], rolls[0]]
        assert [slot_spools.material_matches(s, "PLA") for s in found] == [True, True, False]
        # The K profiles come along, for the dialog to set the slot back to them.
        assert [k.cali_idx for k in found[0].k_profiles] == [5]
        assert len(await restorable_spools(db_session, material="PLA", include_other=True, limit=2)) == 2


class TestPrompts:
    @pytest.mark.asyncio
    async def test_a_refill_under_a_slot_spool_asks(self, db_session, printer_factory):
        printer = await printer_factory()
        slot = await _load(db_session, printer.id)
        own = Spool(material="PLA", label_weight=1000, weight_used=0)
        db_session.add(own)
        await db_session.flush()
        db_session.add(SpoolAssignment(spool_id=own.id, printer_id=printer.id, ams_id=0, tray_id=1))
        await db_session.commit()

        written = await record_refills(db_session, printer.id, [(0, 0), (0, 1), (0, 2)])
        await db_session.commit()

        assert written == 1
        prompts = await list_prompts(db_session)
        assert [(p.ams_id, p.tray_id, p.spool_id) for p in prompts] == [(0, 0, slot.spool_id)]

    @pytest.mark.asyncio
    async def test_loading_a_roll_answers_the_prompt(self, db_session, printer_factory):
        printer = await printer_factory()
        await _load(db_session, printer.id)
        await record_refills(db_session, printer.id, [(0, 0)])
        await db_session.commit()

        await _load(db_session, printer.id)

        assert await list_prompts(db_session) == []
        assert (await db_session.execute(select(SlotSpoolPrompt))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_unassigning_drops_the_prompt(self, db_session, printer_factory):
        printer = await printer_factory()
        slot = await _load(db_session, printer.id)
        await record_refills(db_session, printer.id, [(0, 0)])
        await db_session.commit()

        await db_session.delete(slot)
        await db_session.commit()

        assert (await db_session.execute(select(SlotSpoolPrompt))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_a_prompt_about_another_spool_is_not_listed(self, db_session, printer_factory):
        printer = await printer_factory()
        slot = await _load(db_session, printer.id)
        db_session.add(SlotSpoolPrompt(printer_id=printer.id, ams_id=0, tray_id=0, spool_id=slot.spool_id + 1000))
        await db_session.commit()
        assert await list_prompts(db_session) == []

    @pytest.mark.asyncio
    async def test_same_roll_clears_the_prompt(self, db_session, printer_factory):
        printer = await printer_factory()
        await _load(db_session, printer.id)
        await record_refills(db_session, printer.id, [(0, 0)])
        await db_session.commit()

        assert await clear_prompt(db_session, printer.id, 0, 0) is True
        await db_session.commit()
        assert await list_prompts(db_session) == []
        assert await clear_prompt(db_session, printer.id, 0, 0) is False

    @pytest.mark.asyncio
    async def test_a_slot_empty_again_drops_its_prompt(self, db_session, printer_factory):
        printer = await printer_factory()
        await _load(db_session, printer.id)
        await _load(db_session, printer.id, tray_id=1)
        await record_refills(db_session, printer.id, [(0, 0), (0, 1)])
        await db_session.commit()

        assert await drop_prompts(db_session, printer.id, [(0, 0), (0, 2)]) == 1
        await db_session.commit()

        assert [(p.ams_id, p.tray_id) for p in await list_prompts(db_session)] == [(0, 1)]

    @pytest.mark.asyncio
    async def test_a_runout_switched_to_backup_leaves_no_question(self, db_session, printer_factory, test_engine):
        """Slot 1 ran out mid-print and AMS Filament Backup took over: the slot read
        empty, full, empty. It ended up asking "same roll?" about a slot with
        nothing in it."""
        printer = await printer_factory()
        await _load(db_session, printer.id)
        await _load(db_session, printer.id, tray_id=2)

        sessions = async_sessionmaker(test_engine, expire_on_commit=False)
        with (
            patch("backend.app.core.database.async_session", sessions),
            patch("backend.app.core.websocket.ws_manager.broadcast") as broadcast,
        ):
            for slot0 in (True, False, True):
                await slot_spools.observe_ams(printer.id, [_unit(0, {0: slot0, 1: False, 2: True})])
            assert [(p.ams_id, p.tray_id) for p in await list_prompts(db_session)] == [(0, 0)]

            await slot_spools.observe_ams(printer.id, [_unit(0, {0: False, 1: False, 2: True})])

        assert await list_prompts(db_session) == []
        assert broadcast.await_count == 2


class TestCheckSettings:
    def test_margin_parsing(self):
        assert parse_margin_pct(None) == 0
        assert parse_margin_pct("7.5") == 7.5
        assert parse_margin_pct("-3") == 0
        assert parse_margin_pct("500") == 100
        assert parse_margin_pct("lots") == 0
        assert parse_margin_pct("nan") == 0

    def test_margin_is_added_to_the_grams(self):
        assert CheckSettings(per_slot=True, margin_pct=5).with_margin(200) == pytest.approx(210)

    @pytest.mark.asyncio
    async def test_without_settings_the_check_is_upstreams(self, db_session):
        assert await load_check_settings(db_session) == CheckSettings(per_slot=False, margin_pct=0)

    @pytest.mark.asyncio
    async def test_stored_settings_are_read(self, db_session):
        db_session.add(Settings(key="filament_check_per_slot", value="true"))
        db_session.add(Settings(key="filament_check_margin_pct", value="8"))
        await db_session.commit()
        assert await load_check_settings(db_session) == CheckSettings(per_slot=True, margin_pct=8)

    @pytest.mark.asyncio
    async def test_startup_stores_the_fork_defaults_only_where_missing(self, db_session, test_engine):
        db_session.add(Settings(key="filament_check_margin_pct", value="2"))
        await db_session.commit()

        with patch("backend.app.core.database.async_session", async_sessionmaker(test_engine, expire_on_commit=False)):
            await slot_spools.seed_settings()
            await slot_spools.seed_settings()

        assert await load_check_settings(db_session) == CheckSettings(per_slot=True, margin_pct=2)


# --------------------------------------------------------------- filament check


def _write_3mf(file_path: Path, filaments: list[dict]) -> None:
    body = "".join(
        f'<filament id="{f["id"]}" type="PLA" color="#000000" used_g="{f["used_g"]}" tray_info_idx=""/>'
        for f in filaments
    )
    with zipfile.ZipFile(file_path, "w") as zf:
        zf.writestr("Metadata/slice_info.config", f'<?xml version="1.0" encoding="utf-8"?><config>{body}</config>')


async def _queue_item(db_session, tmp_path: Path, printer_id: int, filaments: list[dict], mapping: list[int]):
    file_path = tmp_path / "model.3mf"
    _write_3mf(file_path, filaments)
    archive = PrintArchive(
        filename="model.3mf",
        print_name="Test",
        file_path=str(file_path),
        file_size=file_path.stat().st_size,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    item = PrintQueueItem(
        printer_id=printer_id,
        archive_id=archive.id,
        ams_mapping=json.dumps(mapping),
        status="pending",
        manual_start=True,
    )
    db_session.add(item)
    await db_session.commit()
    await db_session.refresh(item, ["archive", "library_file"])
    return item


async def _bound_spool(db_session, printer_id: int, tray_id: int, remaining: float, ams_id: int = 0) -> None:
    spool = Spool(
        material="PLA", label_weight=1000, weight_used=1000 - remaining, rgba="000000FF", slicer_filament="GFA00"
    )
    db_session.add(spool)
    await db_session.flush()
    db_session.add(SpoolAssignment(spool_id=spool.id, printer_id=printer_id, ams_id=ams_id, tray_id=tray_id))
    await db_session.commit()


async def _check(db_session, item, printer_id: int, *, backup_on: bool):
    state = SimpleNamespace(ams_filament_backup=backup_on, ams_extruder_map={}, raw_data=None)
    with (
        patch("backend.app.services.filament_deficit.app_settings.base_dir", Path("/")),
        patch(
            "backend.app.services.printer_manager.printer_manager.get_status",
            lambda pid: state if pid == printer_id else None,
        ),
        patch("backend.app.services.printer_manager.printer_manager.get_model", lambda pid: "X1C"),
    ):
        return await compute_deficit_for_queue_item(db_session, item)


async def _settings(db_session, per_slot: bool, margin: int) -> None:
    db_session.add(Settings(key="filament_check_per_slot", value="true" if per_slot else "false"))
    db_session.add(Settings(key="filament_check_margin_pct", value=str(margin)))
    await db_session.commit()


class TestFilamentCheck:
    @pytest.mark.asyncio
    async def test_per_slot_does_not_count_the_backup_spool(self, db_session, printer_factory, tmp_path):
        """10 g in the mapped slot and a full twin next to it: with backup ON the
        printer would switch mid-print and mark the part, so it is short."""
        printer = await printer_factory()
        await _bound_spool(db_session, printer.id, 0, remaining=10)
        await _bound_spool(db_session, printer.id, 0, remaining=900, ams_id=1)
        item = await _queue_item(db_session, tmp_path, printer.id, [{"id": "1", "used_g": "200"}], [0])

        await _settings(db_session, per_slot=False, margin=0)
        assert await _check(db_session, item, printer.id, backup_on=True) == []

        (
            await db_session.execute(select(Settings).where(Settings.key == "filament_check_per_slot"))
        ).scalar_one().value = "true"
        await db_session.commit()
        deficit = await _check(db_session, item, printer.id, backup_on=True)
        assert [(d.tray_id, d.required_grams, d.remaining_grams) for d in deficit] == [(0, 200, 10)]

    @pytest.mark.asyncio
    async def test_the_margin_turns_an_exact_fit_short(self, db_session, printer_factory, tmp_path):
        printer = await printer_factory()
        await _bound_spool(db_session, printer.id, 0, remaining=100)
        item = await _queue_item(db_session, tmp_path, printer.id, [{"id": "1", "used_g": "100"}], [0])
        await _settings(db_session, per_slot=True, margin=5)

        deficit = await _check(db_session, item, printer.id, backup_on=False)
        assert [(d.required_grams, d.remaining_grams) for d in deficit] == [(pytest.approx(105), 100)]

    @pytest.mark.asyncio
    async def test_two_filaments_on_one_tray_are_weighed_together(self, db_session, printer_factory, tmp_path):
        printer = await printer_factory()
        await _bound_spool(db_session, printer.id, 0, remaining=150)
        item = await _queue_item(
            db_session, tmp_path, printer.id, [{"id": "1", "used_g": "100"}, {"id": "2", "used_g": "80"}], [0, 0]
        )
        await _settings(db_session, per_slot=True, margin=0)

        deficit = await _check(db_session, item, printer.id, backup_on=False)
        assert [(d.slot_id, d.required_grams) for d in deficit] == [(1, 180), (2, 180)]
