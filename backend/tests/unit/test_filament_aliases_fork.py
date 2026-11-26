"""Colours and filament profiles marked as the same, in the queue's matching (fork).

See services/filament_aliases.py. The cases are a farm's own: P1S files sliced
on Generic PETG (GFG99), H2S files and every AMS slot on a user preset of the
same PETG, and an FDE colour re-picked after half the files were sliced.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from backend.app.services import filament_aliases as aliases
from backend.app.services.print_scheduler import PrintScheduler

USER_PRESET = "P1a2b3c4"


@pytest.fixture(autouse=True)
def no_groups():
    aliases.apply(aliases.Aliases())
    yield
    aliases.apply(aliases.Aliases())


def _raw(*trays: tuple[str, str, str]) -> dict:
    return {
        "ams": [
            {
                "id": 0,
                "tray": [
                    {"id": i, "tray_type": kind, "tray_color": f"{color}FF", "tray_info_idx": idx}
                    for i, (kind, color, idx) in enumerate(trays)
                ],
            }
        ]
    }


def _forced(color: str, idx: str) -> list[dict]:
    return [{"slot_id": 1, "type": "PETG", "color": color, "tray_info_idx": idx, "force_color_match": True}]


# --- the groups ---------------------------------------------------------------------


def test_groups_are_cleaned_and_joined():
    got = aliases.clean(
        {
            "colors": [["#DCDB4E", "e2df60ff", "nonsense"], ["#E2DF60", "#F0E68C"], ["#000000"]],
            "presets": [[" GFG99 ", USER_PRESET, "GFG99"], [""], ["GFA00"]],
        }
    )
    # A colour in two groups joins them; a group of one is no group.
    assert got.colors == (("dcdb4e", "e2df60", "f0e68c"),)
    assert got.presets == (("GFG99", USER_PRESET),)
    assert aliases.clean(None) == aliases.Aliases()


def test_a_member_stands_for_its_group():
    aliases.apply(aliases.clean({"colors": [["#DCDB4E", "#E2DF60"]], "presets": [["GFG99", USER_PRESET]]}))
    assert aliases.color("e2df60") == aliases.color("dcdb4e") == "dcdb4e"
    assert aliases.color("000000") == "000000"
    assert aliases.preset(USER_PRESET) == aliases.preset(" GFG99") == "GFG99"
    assert aliases.preset("GFA00") == "GFA00"
    assert aliases.preset(None) == ""
    rows = [{"tray_info_idx": USER_PRESET, "global_tray_id": 1}, {"tray_info_idx": "GFG02", "global_tray_id": 2}]
    seen = aliases.with_presets(rows)
    assert [r["tray_info_idx"] for r in seen] == ["GFG99", "GFG02"]
    assert seen[1] is rows[1] and rows[0]["tray_info_idx"] == USER_PRESET  # copies, never the caller's rows


# --- the queue ----------------------------------------------------------------------


def test_a_forced_job_on_another_profile_of_the_same_filament_waits_until_they_are_one():
    scheduler = PrintScheduler()
    raw = _raw(("PETG", "000000", USER_PRESET), ("PETG", "FFFFFF", "GFG02"))
    job = _forced("#000000", "GFG99")
    assert scheduler._get_missing_force_color_slots(1, job, raw) == ["PETG (#000000)"]

    aliases.apply(aliases.clean({"presets": [["GFG99", USER_PRESET]]}))
    assert scheduler._get_missing_force_color_slots(1, job, raw) == []
    # Still the colour that counts.
    assert scheduler._get_missing_force_color_slots(1, _forced("#E2DF60", "GFG99"), raw) == ["PETG (#E2DF60)"]


def test_a_forced_job_in_a_colour_marked_as_the_same_takes_that_spool():
    scheduler = PrintScheduler()
    raw = _raw(("PETG", "E2DF60", USER_PRESET), ("PETG", "000000", USER_PRESET))
    job = _forced("#DCDB4E", USER_PRESET)
    assert scheduler._get_missing_force_color_slots(1, job, raw) == ["PETG (#DCDB4E)"]

    aliases.apply(aliases.clean({"colors": [["#DCDB4E", "#E2DF60"]]}))
    assert scheduler._get_missing_force_color_slots(1, job, raw) == []
    loaded = scheduler._build_loaded_filaments(MagicMock(raw_data=raw))
    assert scheduler._match_filaments_to_slots(job, loaded) == [0]


def test_the_matcher_picks_the_spool_of_a_profile_marked_as_the_same():
    scheduler = PrintScheduler()
    raw = _raw(("PETG", "000000", USER_PRESET), ("PETG", "000000", "GFG02"))
    loaded = scheduler._build_loaded_filaments(MagicMock(raw_data=raw))
    job = _forced("#000000", "GFG99")
    # Unmarked, two black PETGs that name other profiles: no forced match.
    assert scheduler._match_filaments_to_slots(job, loaded) == [-1]

    aliases.apply(aliases.clean({"presets": [["GFG99", USER_PRESET]]}))
    assert scheduler._match_filaments_to_slots(job, loaded) == [0]
    # The trays as the printer reports them are untouched.
    assert loaded[0]["tray_info_idx"] == USER_PRESET
