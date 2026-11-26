"""The product planner: preferred printers and the filament on the spools (fork).

See services/product_planner.py ("Filament" and "preference" in the module docstring).
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

from backend.app.services.product_planner import (
    OVERRULED_EARLIER,
    OVERRULED_FILAMENT,
    OVERRULED_UNAVAILABLE,
    SWAP_CHANGE,
    SWAP_LOAD,
    FilamentUse,
    OrderNeed,
    PartSpec,
    PlanInputs,
    PlannerPrinter,
    PlateOption,
    Preference,
    plan,
)

NOW = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)
H = 3600
TRAY = 3
PARTS = [PartSpec(TRAY, 1, False)]
TRAY_X1, TRAY_X2 = 1, 2
GREEN = FilamentUse("PETG", "#00ae42", 100.0)


def _inputs(units: int = 1, *, free_b: timedelta = timedelta(0), **kw) -> PlanInputs:
    """Two P1S printers (1 free now, 2 after ``free_b``) and a tray plate of 2 h."""
    values = {
        "now": NOW,
        "parts": PARTS,
        "options": [PlateOption(TRAY_X1, "p1s", 2 * H, ((TRAY, 1),))],
        "printers": [PlannerPrinter(1, "p1s", NOW), PlannerPrinter(2, "p1s", NOW + free_b)],
        "orders": [OrderNeed(10, units)],
        "stock": {},
        "plate_cost_s": 0,
    }
    values.update(kw)
    return PlanInputs(**values)


def _prefer(printer_id: int, plate_id: int = TRAY_X1) -> list[Preference]:
    return [Preference(printer_id, plate_id, frozenset({TRAY}))]


def _on(printer_id: int, **kw) -> dict:
    """Filament: the tray takes green PETG from tray 0 on ``printer_id``; the other printer has none."""
    other = 2 if printer_id == 1 else 1
    return {
        "filament_use": {TRAY_X1: {printer_id: (replace(GREEN, tray=0),), other: (GREEN,)}},
        **kw,
    }


# --- preferences ---------------------------------------------------------------------


def test_without_a_preference_the_printer_done_first_takes_the_plate():
    [plate] = plan(_inputs(free_b=timedelta(minutes=20))).plates
    assert plate.printer_id == 1
    assert plate.preferred is None


def test_a_preferred_printer_wins_when_it_is_done_a_little_later():
    # Done 20 minutes later than printer 1: within the margin (30 min, 25 % of 2 h).
    [plate] = plan(_inputs(free_b=timedelta(minutes=20), preferences=_prefer(2))).plates
    assert plate.printer_id == 2
    assert plate.preferred == 2
    assert plate.overruled is None


def test_another_printer_done_much_sooner_wins_over_the_preference():
    [plate] = plan(_inputs(free_b=timedelta(hours=3), preferences=_prefer(2))).plates
    assert plate.printer_id == 1
    # The plate still carries the preference, and says why it is elsewhere.
    assert plate.preferred == 2
    assert plate.overruled == OVERRULED_EARLIER
    assert plate.overruled_by_s == 3 * H


def test_the_margin_grows_with_the_plate_print_time():
    # 50 % of a 2 h plate is an hour: done 45 minutes later still wins.
    inputs = _inputs(free_b=timedelta(minutes=45), preferences=_prefer(2), prefer_pct=50.0)
    [plate] = plan(inputs).plates
    assert plate.printer_id == 2
    inputs = _inputs(free_b=timedelta(minutes=45), preferences=_prefer(2))
    assert plan(inputs).plates[0].printer_id == 1


def test_a_preference_for_a_printer_that_cannot_print_now_is_kept_and_says_so():
    inputs = _inputs(printers=[PlannerPrinter(1, "p1s", NOW)], preferences=_prefer(2))
    [plate] = plan(inputs).plates
    assert (plate.printer_id, plate.preferred, plate.overruled) == (1, 2, OVERRULED_UNAVAILABLE)


def test_a_preference_carries_to_a_bigger_plate_of_the_same_parts():
    options = [
        PlateOption(TRAY_X1, "p1s", 2 * H, ((TRAY, 1),)),
        PlateOption(TRAY_X2, "p1s", int(3.2 * H), ((TRAY, 2),)),
    ]
    inputs = _inputs(2, options=options, free_b=timedelta(minutes=10), preferences=_prefer(2))
    plates = plan(inputs).plates
    assert [p.printer_id for p in plates if p.preferred == 2] == [2]


def test_each_preference_goes_to_one_plate():
    inputs = _inputs(2, preferences=_prefer(2) + _prefer(1))
    plates = plan(inputs).plates
    assert sorted((p.printer_id, p.preferred) for p in plates) == [(1, 1), (2, 2)]


# --- filament ------------------------------------------------------------------------


def test_a_printer_without_the_filament_waits_for_someone_to_load_it():
    # 22:00: nobody is there until 7:00, so printer 1 (no green PETG) waits for the
    # morning, and printer 2, free in an hour with the spool, prints it tonight.
    late = NOW.replace(hour=22)

    def staffed(t: datetime) -> datetime:
        return t if 7 <= t.hour < 19 else (t + timedelta(days=1)).replace(hour=7, minute=0)

    inputs = _inputs(
        now=late,
        printers=[PlannerPrinter(1, "p1s", late), PlannerPrinter(2, "p1s", late + timedelta(hours=1))],
        staffed_at=staffed,
        filament_left={2: {0: 800.0}},
        **_on(2),
    )
    [plate] = plan(inputs).plates
    assert plate.printer_id == 2
    assert plate.swap is None
    [note] = plate.filament
    assert (note.type, note.tray, note.left, note.swap) == ("PETG", 0, 700.0, None)


def test_loading_the_filament_takes_the_swap_time():
    inputs = _inputs(printers=[PlannerPrinter(1, "p1s", NOW)], swap_s=600, **_on(2))
    [plate] = plan(inputs).plates
    assert plate.swap == SWAP_LOAD
    assert plate.start == NOW + timedelta(minutes=10)
    # A fresh spool: the next plate of the same filament needs none.
    [note] = plate.filament
    assert note.left == 900.0


def test_a_spool_that_would_run_out_is_changed_first():
    # 104 g left; the plate takes 100 g plus the check's 5 %.
    inputs = _inputs(
        printers=[PlannerPrinter(1, "p1s", NOW)],
        filament_left={1: {0: 104.0}},
        filament_margin_pct=5.0,
        **_on(1),
    )
    [plate] = plan(inputs).plates
    assert plate.swap == SWAP_CHANGE
    assert plate.filament[0].left == 900.0
    assert plate.start == NOW + timedelta(seconds=600)


def test_the_spools_follow_the_plan_plate_by_plate():
    inputs = _inputs(2, printers=[PlannerPrinter(1, "p1s", NOW)], filament_left={1: {0: 150.0}}, **_on(1))
    plates = sorted(plan(inputs).plates, key=lambda p: p.start)
    assert [p.swap for p in plates] == [None, SWAP_CHANGE]
    assert [p.filament[0].left for p in plates] == [50.0, 900.0]


def test_an_unknown_amount_is_not_counted():
    inputs = _inputs(printers=[PlannerPrinter(1, "p1s", NOW)], **_on(1))
    [plate] = plan(inputs).plates
    assert plate.swap is None
    assert plate.filament[0].left is None
    assert plate.start == NOW


def test_the_preference_yields_to_a_printer_with_the_filament():
    # Printer 1 is preferred and done only 10 minutes later (the load), within
    # the margin, but it needs a spool loaded and printer 2 has it.
    inputs = _inputs(preferences=_prefer(1), swap_s=600, **_on(2))
    [plate] = plan(inputs).plates
    assert plate.printer_id == 2
    assert (plate.preferred, plate.overruled) == (1, OVERRULED_FILAMENT)


def test_a_preference_holds_when_every_printer_needs_a_swap():
    inputs = _inputs(
        free_b=timedelta(minutes=20),
        preferences=_prefer(2),
        filament_use={TRAY_X1: {1: (GREEN,), 2: (GREEN,)}},
    )
    [plate] = plan(inputs).plates
    assert (plate.printer_id, plate.swap, plate.overruled) == (2, SWAP_LOAD, None)
