"""What a product's plates take from a printer's spools, as the scheduler matches them (fork).

See services/product_filament.py.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from backend.app.services import product_filament
from backend.app.services.product_filament import PrinterSpools
from backend.app.services.product_planner import FilamentUse


def _tray(gtid: int, kind: str, color: str) -> dict:
    return {
        "type": kind,
        "color": color,
        "color_known": True,
        "tray_info_idx": "",
        "ams_id": 0,
        "tray_id": gtid,
        "is_ht": False,
        "is_external": False,
        "global_tray_id": gtid,
        "extruder_id": None,
        "remain": -1,
    }


SPOOLS = PrinterSpools(loaded=[_tray(0, "PETG", "#000000"), _tray(1, "PETG", "#00AE42")], left={1: 640.0})


def _req(color: str, grams: float = 120.0, slot: int = 1) -> dict:
    return {"slot_id": slot, "type": "PETG", "color": color, "tray_info_idx": "", "used_grams": grams}


def test_a_forced_colour_takes_the_tray_with_that_colour():
    [use] = product_filament.match([_req("#00AE42FF")], SPOOLS, force=True)
    assert use == FilamentUse("PETG", "#00ae42", 120.0, 1)


def test_a_forced_colour_no_tray_holds_has_no_tray():
    [use] = product_filament.match([_req("#FF0000")], SPOOLS, force=True)
    assert use.tray is None


def test_without_forcing_the_type_alone_will_do():
    [use] = product_filament.match([_req("#FF0000")], SPOOLS, force=False)
    assert use.tray in (0, 1)


def test_a_printer_with_no_spools_has_no_tray_for_anything():
    [use] = product_filament.match([_req("#00AE42")], PrinterSpools(loaded=[]), force=True)
    assert use.tray is None


def test_filaments_the_plate_does_not_print_are_left_out():
    assert product_filament.match([_req("#00AE42", grams=0)], SPOOLS, force=True) == ()


def test_a_queue_job_takes_the_trays_it_was_given_on_its_printer(monkeypatch):
    monkeypatch.setattr(product_filament, "requirements", lambda path, plate: [_req("#00AE42", 80.0)])
    item = SimpleNamespace(
        id=7,
        plate_id=None,
        printer_id=3,
        ams_mapping=json.dumps([0]),
        filament_overrides=None,
        archive=None,
        library_file=None,
    )
    assert [u.tray for u in product_filament.item_uses(item, 3, SPOOLS)] == [0]
    # On another printer it is matched like any job.
    assert [u.tray for u in product_filament.item_uses(item, 4, SPOOLS)] == [1]


def test_take_counts_only_known_amounts():
    left = {1: 640.0}
    product_filament.take(left, [FilamentUse("PETG", "#00ae42", 100.0, 1), FilamentUse("PETG", "#000000", 50.0, 0)])
    assert left == {1: 540.0}


def test_force_colour_overrides_name_every_filament_of_the_plate():
    overrides = json.loads(product_filament.force_color_overrides([_req("#00AE42FF"), _req("#000000", slot=2)]))
    assert overrides == [
        {"slot_id": 1, "type": "PETG", "color": "#00ae42", "tray_info_idx": "", "force_color_match": True},
        {"slot_id": 2, "type": "PETG", "color": "#000000", "tray_info_idx": "", "force_color_match": True},
    ]
    assert product_filament.force_color_overrides([]) is None
