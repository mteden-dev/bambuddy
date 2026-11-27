"""The product planner: the improvement pass and failure risk (fork).

See services/product_planner.py (step 4 and ``PlateOption.risk`` in the module docstring).
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services import product_planner as planner
from backend.app.services.product_planner import (
    FilamentUse,
    OrderNeed,
    PartSpec,
    Plan,
    PlanInputs,
    PlannerPrinter,
    PlateOption,
    Preference,
    plan,
)

NOW = datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc)
NIGHT = NOW.replace(hour=22)
H = 3600
PART = 1
SINGLE = PlateOption(1, "p1s", 2 * H, ((PART, 1),))
QUAD = PlateOption(2, "p1s", 7 * H, ((PART, 4),))


def _staffed_8_to_16(end: datetime) -> datetime:
    """Someone clears plates from 8:00 to 16:00, in 10 minutes."""
    if 8 <= end.hour < 16:
        return end + timedelta(minutes=10)
    morning = end.replace(hour=8, minute=0, second=0, microsecond=0)
    if end.hour >= 16:
        morning += timedelta(days=1)
    return morning + timedelta(minutes=10)


def _at(day: int, hour: int, minute: int = 0) -> datetime:
    return NOW.replace(day=day, hour=hour, minute=minute)


def _one_part(units: int, *, free: datetime = NOW, options=(SINGLE, QUAD), matched: bool = False, **kw) -> PlanInputs:
    values = {
        "now": NOW,
        "parts": [PartSpec(PART, 1, matched)],
        "options": list(options),
        "printers": [PlannerPrinter(1, "p1s", free)],
        "orders": [OrderNeed(10, units)],
        "stock": {},
        "ready_after": _staffed_8_to_16,
    }
    values.update(kw)
    return PlanInputs(**values)


def _enumerated(inputs: PlanInputs, monkeypatch) -> Plan:
    """The plan the enumeration alone gives (no improvement pass)."""
    with monkeypatch.context() as patch:
        patch.setattr(planner, "_improve", lambda inputs, start, covers: start)
        return plan(inputs)


def _improve(inputs: PlanInputs, start: Plan) -> Plan:
    matched_ids = frozenset(p.id for p in inputs.parts if p.matched)
    return planner._improve(inputs, start, planner._Covers(inputs, matched_ids))


# --- the clock --------------------------------------------------------------------------


def test_a_printer_free_at_night_prints_one_long_plate_through_it():
    # Three singles: the first waits for the morning, the others print in the
    # day (ready 12:30). One quad runs through the night: ready at 8:10.
    result = plan(_one_part(3, free=NIGHT))
    assert [p.option.id for p in result.plates] == [QUAD.id]
    assert result.ready_at == {10: _at(25, 8, 10)}


def test_in_the_day_three_singles_still_win():
    result = plan(_one_part(3))
    assert [p.option.id for p in result.plates] == [SINGLE.id] * 3
    assert result.ready_at == {10: _at(24, 14, 30)}


@pytest.mark.parametrize("options", [(SINGLE, QUAD), (QUAD, SINGLE)])
def test_the_long_plate_prints_into_the_night_whichever_way_the_plates_are_listed(options):
    # 7 pieces from 8:00: the long plate last in the day runs through the night.
    result = plan(_one_part(7, options=options))
    assert result.ready_at == {10: _at(25, 8, 10)}
    _check(_one_part(7, options=options), result)


def test_the_improvement_never_costs_more_than_the_enumeration(monkeypatch):
    for inputs in (_one_part(3, free=NIGHT), _one_part(7, options=(QUAD, SINGLE)), _mixed()):
        assert plan(inputs).cost <= _enumerated(inputs, monkeypatch).cost


# --- moves between printers -----------------------------------------------------------


def _two_printers(units: int, *, matched: bool = False) -> PlanInputs:
    return _one_part(
        units,
        matched=matched,
        printers=[PlannerPrinter(1, "p1s", NOW), PlannerPrinter(2, "p1s", NOW)],
    )


def _all_on_printer_1(units: int, *, matched: bool = False) -> Plan:
    """A plan with every plate on printer 1 (planned as if printer 2 were not there)."""
    return plan(_one_part(units, matched=matched))


def test_a_plate_moves_to_another_printer_when_that_is_cheaper():
    inputs = _two_printers(2)
    start = _all_on_printer_1(2)
    assert {p.printer_id for p in start.plates} == {1}
    result = _improve(inputs, start)
    assert sorted(p.printer_id for p in result.plates) == [1, 2]
    assert result.ready_at == {10: _at(24, 10, 10)}
    assert result.cost < start.cost
    _check(inputs, result, start)


def test_a_pinned_plate_stays_on_its_printer():
    inputs = _two_printers(2, matched=True)
    start = _all_on_printer_1(2, matched=True)
    assert all(p.pinned for p in start.plates)
    result = _improve(inputs, start)
    assert {p.printer_id for p in result.plates} == {1}
    _check(inputs, result, start)


def test_a_preferred_plate_stays_on_its_printer():
    inputs = _two_printers(2)
    start = _all_on_printer_1(2)
    start = replace(start, plates=[replace(p, preferred=1) for p in start.plates])
    result = _improve(inputs, start)
    assert {p.printer_id for p in result.plates} == {1}
    assert result.preference_s == start.preference_s


def test_plates_swapped_into_a_matched_package_stay_pinned():
    # A matched package of four lid-and-tray plates is swapped for single lids
    # and a plate of four trays: the tray plate takes the package's place on
    # its printer, pinned like the plates it replaced (as the enumeration pins
    # a package's plates), so the same plate is not pinned in one plan and
    # loose in the next.
    lid, tray = 21, 22
    both = PlateOption(31, "p1s", 3 * H, ((lid, 1), (tray, 1)))
    lid_only = PlateOption(32, "p1s", 1 * H, ((lid, 1),))
    trays = PlateOption(33, "p1s", 3 * H, ((tray, 4),))
    inputs = _one_part(4, parts=[PartSpec(lid, 1, True), PartSpec(tray, 1, False)], options=[both, lid_only, trays])
    record: list = []
    planner._run(inputs, 1, [both] * 4, NOW, planner._fresh_spools(inputs, 1), record)
    plates = [planner.PlannedPlate(o, 1, s, e, r, True, filament=n, swap=w) for o, s, e, r, n, w in record]
    to_make = planner._to_make(inputs, planner._have(inputs))
    fixed, extra = planner._fixed_cost(inputs, plates, to_make, planner._piece_times(inputs))
    waits, ready_at = planner._wait_cost(inputs, plates)
    start = Plan(plates=plates, ready_at=ready_at, cost=fixed + waits, extra=extra)

    result = _improve(inputs, start)
    assert result.cost < start.cost
    assert trays.id in [p.option.id for p in result.plates]
    assert all(p.pinned for p in result.plates)
    _check(inputs, result, start)


def test_the_improved_plan_keeps_the_enumeration_report():
    inputs = _two_printers(2)
    start = replace(_all_on_printer_1(2), alternatives={"cheapest": 1.0})
    result = _improve(inputs, start)
    assert (result.caps, result.packing, result.alternatives) == (start.caps, start.packing, start.alternatives)


# --- invariants on a mixed case ----------------------------------------------------------

LID, BASE, TRAY = 11, 12, 13
INK, PAPER = "#203040", "#e0d0c0"


def _mixed() -> PlanInputs:
    """Matched lid and base, a loose tray that dries, two models, staffed hours, filament."""
    parts = [PartSpec(LID, 1, True), PartSpec(BASE, 1, True, H), PartSpec(TRAY, 1, False, H)]
    sizes = {"p1s": ((1, 2.0), (2, 3.67), (3, 5.2)), "h2s": ((1, 1.8), (3, 4.6), (6, 8.5))}
    options = []
    ids = iter(range(100, 200))
    for model, steps in sizes.items():
        for part in (LID, BASE, TRAY):
            for n, hours in steps:
                options.append(PlateOption(next(ids), model, int(hours * H), ((part, n),)))
        options.append(PlateOption(next(ids), model, int(steps[0][1] * 2.6 * H), ((LID, 1), (BASE, 1), (TRAY, 1))))
    printers = [PlannerPrinter(i + 1, ("p1s", "h2s")[i % 2], NOW + timedelta(hours=i)) for i in range(4)]
    filament_use = {
        o.id: {
            p.id: (FilamentUse("PLA", INK if o.id % 2 else PAPER, 30.0 * o.duration_s / H, 0 if o.id % 2 else None),)
            for p in printers
        }
        for o in options
    }
    return PlanInputs(
        now=NOW,
        parts=parts,
        options=options,
        printers=printers,
        orders=[OrderNeed(i + 1, 3, NOW + timedelta(days=1 + i)) for i in range(3)],
        stock={LID: {1: 1}, TRAY: {0: 2}},
        ready_after=_staffed_8_to_16,
        staffed_at=lambda t: _staffed_8_to_16(t) - timedelta(minutes=10),
        filament_use=filament_use,
        filament_left={p.id: {0: 400.0} for p in printers},
        preferences=[Preference(2, options[0].id, frozenset({LID}))],
    )


def _matched_by_printer(inputs: PlanInputs, result: Plan) -> dict[tuple[int, int], int]:
    matched = {p.id for p in inputs.parts if p.matched}
    made: dict[tuple[int, int], int] = {}
    for planned in result.plates:
        for part_id, n in planned.option.pieces:
            if part_id in matched:
                made[planned.printer_id, part_id] = made.get((planned.printer_id, part_id), 0) + n
    return made


def _check(inputs: PlanInputs, result: Plan, start: Plan | None = None) -> None:
    """Every plate re-times to what it says, the plan's numbers agree with its plates, and nothing got worse."""
    printers = {p.id: p for p in inputs.printers}
    for printer_id, printer in printers.items():
        lane = sorted((p for p in result.plates if p.printer_id == printer_id), key=lambda p: p.start)
        record: list = []
        planner._run(
            inputs,
            printer_id,
            [p.option for p in lane],
            max(printer.free_at, inputs.now),
            planner._fresh_spools(inputs, printer_id),
            record,
        )
        for planned, (option, begin, end, ready, notes, swap) in zip(lane, record, strict=True):
            assert planned.option.runs_on(printer)
            if any(option.count(p.id) for p in inputs.parts if p.matched):
                assert planned.pinned
            assert (planned.start, planned.end, planned.ready, planned.filament, planned.swap) == (
                begin,
                end,
                ready,
                notes,
                swap,
            )
    to_make = planner._to_make(inputs, planner._have(inputs))
    fixed, extra = planner._fixed_cost(inputs, result.plates, to_make, planner._piece_times(inputs))
    waits, ready_at = planner._wait_cost(inputs, result.plates)
    assert result.cost == pytest.approx(fixed + result.preference_s + waits)
    assert result.ready_at == ready_at
    assert result.extra == extra
    made: dict[int, int] = {}
    for planned in result.plates:
        for part_id, n in planned.option.pieces:
            made[part_id] = made.get(part_id, 0) + n
    for part in inputs.parts:
        if not part.matched:
            assert result.short.get(part.id, 0) == max(0, to_make[part.id] - made.get(part.id, 0))
    if start is not None:
        for part_id, n in result.short.items():
            assert n <= start.short.get(part_id, 0)
        before = _matched_by_printer(inputs, start)
        after = _matched_by_printer(inputs, result)
        assert all(after.get(key, 0) >= n for key, n in before.items())
        for planned in start.plates:
            if planned.preferred is not None:
                assert any(
                    p.option.id == planned.option.id and p.printer_id == planned.printer_id for p in result.plates
                )


def test_the_improved_mixed_plan_keeps_every_invariant(monkeypatch):
    inputs = _mixed()
    start = _enumerated(inputs, monkeypatch)
    result = _improve(inputs, start)
    assert result.cost < start.cost  # the case has something to improve
    assert (result.caps, result.packing) == (start.caps, start.packing)
    _check(inputs, result, start)


def test_the_planned_mixed_case_agrees_with_its_plates(monkeypatch):
    inputs = _mixed()
    result = plan(inputs)
    _check(inputs, result)
    assert result.cost <= _enumerated(inputs, monkeypatch).cost
    assert not result.short


# --- failure risk --------------------------------------------------------------------------


def test_a_risky_plate_loses_to_safe_plates_of_the_same_print_time_per_piece():
    risky = PlateOption(3, "p1s", 4 * H, ((PART, 2),), risk=0.5)
    safe = PlateOption(4, "p1s", 2 * H, ((PART, 1),))
    assert planner._cheapest_cover([replace(risky, risk=0.0), safe], ((PART, 2),), 0) == (replace(risky, risk=0.0),)
    assert planner._cheapest_cover([risky, safe], ((PART, 2),), 0) == (safe, safe)


def test_a_plan_avoids_a_risky_plate():
    # One plate for both pieces saves a plate change, unless it fails often.
    double = PlateOption(3, "p1s", 4 * H, ((PART, 2),))
    options = (double, SINGLE)
    assert [p.option.id for p in plan(_one_part(2, options=options)).plates] == [double.id]
    risky = (replace(double, risk=0.6), SINGLE)
    assert [p.option.id for p in plan(_one_part(2, options=risky)).plates] == [SINGLE.id] * 2


def test_the_plan_cost_counts_the_risk_once_per_plate():
    safe = plan(_one_part(1, options=(SINGLE,)))
    risky = plan(_one_part(1, options=(replace(SINGLE, risk=0.1),)))
    assert risky.cost - safe.cost == pytest.approx(0.1 * (SINGLE.duration_s + 900))


def test_no_risk_changes_nothing():
    inputs = _mixed()
    explicit = replace(inputs, options=[replace(o, risk=0.0) for o in inputs.options])
    a, b = plan(inputs), plan(explicit)
    assert a.cost == b.cost
    assert [(p.option.id, p.printer_id, p.start) for p in a.plates] == [
        (p.option.id, p.printer_id, p.start) for p in b.plates
    ]
