"""The product planner: sharing stock between orders, choosing plates and printers (fork).

See services/product_planner.py.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.app.services.product_planner import (
    Arrival,
    OrderNeed,
    PartSpec,
    PlanInputs,
    PlannerPrinter,
    PlateOption,
    allocate,
    complete_units,
    plan,
    ready_times,
)

NOW = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)
H = 3600
LID, BASE, TRAY = 1, 2, 3
BOX = [PartSpec(LID, 1, True), PartSpec(BASE, 1, True), PartSpec(TRAY, 1, False)]


def _options(*, h2s: bool = True) -> list[PlateOption]:
    """1/2/3 pieces per part on a P1S, 1/3/6 on an H2S (a little faster)."""
    options = []
    next_id = iter(range(1, 100))
    for part in (LID, BASE, TRAY):
        for n, hours in ((1, 2.0), (2, 3.67), (3, 5.2)):
            options.append(PlateOption(next(next_id), "p1s", int(hours * H), ((part, n),)))
        if h2s:
            for n, hours in ((1, 1.8), (3, 4.6), (6, 8.5)):
                options.append(PlateOption(next(next_id), "h2s", int(hours * H), ((part, n),)))
    return options


def _farm(now: datetime = NOW, *, h2s: bool = True) -> list[PlannerPrinter]:
    printers = [PlannerPrinter(1, "p1s", now), PlannerPrinter(2, "p1s", now)]
    if h2s:
        printers.append(PlannerPrinter(3, "h2s", now))
    return printers


def _inputs(orders, **kw) -> PlanInputs:
    h2s = kw.pop("h2s", True)
    values = {
        "now": NOW,
        "parts": BOX,
        "options": _options(h2s=h2s),
        "printers": _farm(h2s=h2s),
        "orders": orders,
        "stock": {},
    }
    values.update(kw)
    return PlanInputs(**values)


def _staffed_7_to_19(end: datetime) -> datetime:
    """Someone clears plates from 7:00 to 19:00, in 10 minutes."""
    if 7 <= end.hour < 19:
        return end + timedelta(minutes=10)
    morning = end.replace(hour=7, minute=0, second=0, microsecond=0)
    if end.hour >= 19:
        morning += timedelta(days=1)
    return morning + timedelta(minutes=10)


# --- allocate ---------------------------------------------------------------------


def test_a_product_takes_its_matched_parts_from_one_printer():
    # A lid on printer 1 and a base on printer 2 do not make a box.
    pool = {LID: {1: 1}, BASE: {2: 1}, TRAY: {1: 1}}
    allocation = allocate(BOX, pool, [OrderNeed(10, 1)])
    assert allocation.units == {10: 0}

    pool[BASE][1] = 1
    allocation = allocate(BOX, pool, [OrderNeed(10, 1)])
    assert allocation.units == {10: 1}
    assert allocation.taken[10] == {LID: {1: 1}, BASE: {1: 1}, TRAY: {1: 1}}


def test_a_piece_of_no_known_printer_goes_with_any_printer():
    # "I have a lid already": a stock correction naming no printer (0).
    pool = {LID: {0: 1}, BASE: {2: 1}, TRAY: {1: 1}}
    allocation = allocate(BOX, pool, [OrderNeed(10, 1)])
    assert allocation.units == {10: 1}
    assert allocation.taken[10] == {LID: {0: 1}, BASE: {2: 1}, TRAY: {1: 1}}
    # A printer's own whole set goes before one completed that way.
    pool = {LID: {0: 1, 1: 1}, BASE: {1: 1, 2: 1}, TRAY: {1: 2}}
    allocation = allocate(BOX, pool, [OrderNeed(10, 1), OrderNeed(11, 1)])
    assert allocation.taken[10][LID] == {1: 1} and allocation.taken[11][LID] == {0: 1}
    assert complete_units(BOX, pool) == 2


def test_orders_share_the_stock_in_order_and_count_partial_pieces():
    pool = {LID: {1: 3}, BASE: {1: 2}, TRAY: {2: 5}}
    allocation = allocate(BOX, pool, [OrderNeed(10, 1), OrderNeed(11, 2)])
    assert allocation.units == {10: 1, 11: 1}
    # The third lid counts towards the second order's missing box.
    assert allocation.pieces[11] == {LID: 2, BASE: 1, TRAY: 2}


def test_ready_times_follow_the_arrivals():
    later = NOW + timedelta(hours=2)
    arrivals = [
        Arrival(NOW, 1, ((LID, 1), (BASE, 1))),
        Arrival(later, 2, ((TRAY, 1),)),
    ]
    assert ready_times(BOX, [OrderNeed(10, 1), OrderNeed(11, 1)], arrivals, NOW) == {10: later, 11: None}


# --- plan ---------------------------------------------------------------------------


def test_one_box_keeps_lid_and_base_on_one_printer_and_takes_the_fastest():
    result = plan(_inputs([OrderNeed(10, 1)]))
    matched = [p for p in result.plates if p.pinned]
    assert {p.printer_id for p in matched} == {3}  # the H2S prints both faster than a P1S
    assert sorted(p.option.pieces for p in matched) == [((LID, 1),), ((BASE, 1),)]
    tray = [p for p in result.plates if not p.pinned]
    assert len(tray) == 1 and tray[0].printer_id in (1, 2)
    assert result.ready_at[10] == NOW + timedelta(hours=3.6)
    assert result.short == {} and result.extra == {}


def test_two_orders_spread_over_the_printers_in_the_day():
    result = plan(_inputs([OrderNeed(10, 1), OrderNeed(11, 1)]))
    # Each box's lid and base come from one printer, and the two boxes print at once.
    by_printer: dict[int, list] = {}
    for p in result.plates:
        if p.pinned:
            by_printer.setdefault(p.printer_id, []).append(p.option.pieces)
    assert len(by_printer) == 2
    for pieces in by_printer.values():
        assert sorted(pieces) == [((LID, 1),), ((BASE, 1),)]
    assert max(result.ready_at.values()) <= NOW + timedelta(hours=4)


def test_a_high_plate_cost_merges_two_boxes_into_bigger_plates():
    cheap = plan(_inputs([OrderNeed(10, 1), OrderNeed(11, 1)], plate_cost_s=0))
    dear = plan(_inputs([OrderNeed(10, 1), OrderNeed(11, 1)], plate_cost_s=4 * H))
    assert len(dear.plates) < len(cheap.plates)
    assert any(n >= 2 for p in dear.plates for _, n in p.option.pieces)


def test_overnight_a_printer_takes_one_bigger_plate_rather_than_waiting_for_the_morning():
    evening = datetime(2026, 11, 24, 18, 0, tzinfo=timezone.utc)
    result = plan(
        _inputs(
            [OrderNeed(10, 3)],
            now=evening,
            printers=_farm(evening),
            ready_after=_staffed_7_to_19,
            h2s=False,
        )
    )
    # Nobody clears plates until 7:00: every printer gets one plate before then,
    # and packing more pieces on it beats leaving them for the morning.
    overnight = [p for p in result.plates if p.start < evening + timedelta(hours=13)]
    assert len({p.printer_id for p in overnight}) == len(overnight)
    assert any(n >= 2 for p in overnight for _, n in p.option.pieces)


def test_a_leftover_lid_is_finished_on_its_own_printer():
    # Printer 2 printed a lid whose base failed: one base there makes the box.
    result = plan(_inputs([OrderNeed(10, 1)], stock={LID: {2: 1}}))
    matched = [p for p in result.plates if p.pinned]
    assert [(p.printer_id, p.option.pieces) for p in matched] == [(2, ((BASE, 1),))]


def test_a_lid_on_hand_leaves_only_the_base_to_print():
    # The lid's printer is not known: the base may come from any printer.
    result = plan(_inputs([OrderNeed(10, 1)], stock={LID: {0: 1}}))
    printed = sorted(piece for p in result.plates for piece in p.option.pieces)
    assert printed == [(BASE, 1), (TRAY, 1)]
    assert result.extra == {}


def test_stock_from_an_earlier_overrun_is_used_before_printing():
    stock = {LID: {1: 1}, BASE: {1: 1}, TRAY: {2: 1}}
    result = plan(_inputs([OrderNeed(10, 1)], stock=stock))
    assert result.plates == []
    assert result.ready_at == {10: NOW}


def test_pieces_printing_now_count_as_coming():
    later = NOW + timedelta(hours=1)
    arriving = [Arrival(later, 1, ((LID, 1), (BASE, 1), (TRAY, 1)))]
    result = plan(_inputs([OrderNeed(10, 1)], arriving=arriving))
    assert result.plates == []
    assert result.ready_at == {10: later}


def test_a_plate_with_several_parts_prints_a_whole_set():
    combo = PlateOption(50, "h2s", int(3 * H), ((LID, 1), (BASE, 1), (TRAY, 1)))
    result = plan(_inputs([OrderNeed(10, 1)], options=[combo], printers=[PlannerPrinter(3, "h2s", NOW)]))
    assert [(p.option.id, p.pinned) for p in result.plates] == [(50, True)]
    assert result.ready_at == {10: NOW + timedelta(hours=3)}


def test_parts_without_a_plate_for_any_printer_are_short():
    options = [o for o in _options(h2s=False) if o.count(TRAY) == 0]
    result = plan(_inputs([OrderNeed(10, 2)], options=options, h2s=False))
    assert result.short == {TRAY: 2}
    assert result.ready_at == {10: None}


def test_printer_tags_keep_a_plate_off_other_printers():
    options = [
        PlateOption(o.id, o.model, o.duration_s, o.pieces, frozenset({2}) if o.count(TRAY) else None)
        for o in _options(h2s=False)
    ]
    result = plan(_inputs([OrderNeed(10, 2)], options=options, h2s=False))
    assert {p.printer_id for p in result.plates if p.option.count(TRAY)} == {2}


def test_a_due_date_keeps_bigger_plates_from_making_an_order_late():
    # With plates this dear the two boxes would share 2-piece plates (17:20);
    # the first is due at 14:00, so it gets its own plates and is ready in time.
    soon = NOW + timedelta(hours=4)
    merged = plan(_inputs([OrderNeed(11, 1), OrderNeed(10, 1)], plate_cost_s=4 * H))
    assert merged.ready_at[11] > soon
    due = plan(_inputs([OrderNeed(11, 1, due=soon), OrderNeed(10, 1)], plate_cost_s=4 * H))
    assert due.ready_at[11] is not None and due.ready_at[11] <= soon
    assert len(due.plates) > len(merged.plates)


def test_nothing_to_do_without_orders():
    result = plan(_inputs([]))
    assert result.plates == [] and result.ready_at == {}


def test_parts_that_dry_after_printing_go_first_and_count_later():
    # The tray is glued into the base and dries an hour: on one printer the base
    # prints before the lid, which prints while it dries.
    box = [PartSpec(LID, 1, True), PartSpec(BASE, 1, True, finish_s=H), PartSpec(TRAY, 1, False, finish_s=H)]
    result = plan(_inputs([OrderNeed(10, 1)], parts=box, h2s=False))
    matched = [p for p in result.plates if p.pinned]
    assert [p.option.pieces for p in sorted(matched, key=lambda p: p.start)] == [((BASE, 1),), ((LID, 1),)]
    # Base 10-12 (+1 h drying), tray 10-12 (+1 h), lid 12-14: ready at 14:00.
    assert result.ready_at[10] == NOW + timedelta(hours=4)


def test_finishing_time_holds_an_order_back_until_it_has_passed():
    box = [PartSpec(LID, 1, True), PartSpec(BASE, 1, True, finish_s=H), PartSpec(TRAY, 1, False)]
    later = NOW + timedelta(hours=2)
    arrivals = [Arrival(later, 1, ((LID, 1), (BASE, 1), (TRAY, 1)))]
    assert ready_times(box, [OrderNeed(10, 1)], arrivals, NOW) == {10: later + timedelta(hours=1)}
    # Pieces in stock are finished already.
    stock = [Arrival(NOW, 1, ((LID, 1), (BASE, 1), (TRAY, 1)), finished=True)]
    assert ready_times(box, [OrderNeed(10, 1)], stock, NOW) == {10: NOW}


def test_on_one_printer_the_tray_prints_before_the_lid():
    # Gluing waits for both base and tray: the lid, which needs no work, goes last.
    box = [PartSpec(LID, 1, True), PartSpec(BASE, 1, True, finish_s=H), PartSpec(TRAY, 1, False, finish_s=H)]
    one = [PlannerPrinter(1, "p1s", NOW)]
    result = plan(_inputs([OrderNeed(10, 1)], parts=box, h2s=False, printers=one))
    assert [p.option.pieces for p in sorted(result.plates, key=lambda p: p.start)] == [
        ((BASE, 1),),
        ((TRAY, 1),),
        ((LID, 1),),
    ]
    # Base 10-12, tray 12-14 (+1 h: 15:00), lid 14-16: ready at 16:00, not 17:00.
    assert result.ready_at[10] == NOW + timedelta(hours=6)


# A box as one P1S prints it: base 1h19, lid 1h02 and tray 27 min on plates of
# their own, or all three on one plate. The base and the tray are glued and dry
# an hour.
GLUED_BOX = [PartSpec(LID, 1, True), PartSpec(BASE, 1, True, finish_s=H), PartSpec(TRAY, 1, False, finish_s=H)]


def _box_plates(all_in_one_min: int) -> list[PlateOption]:
    return [
        PlateOption(60, "p1s", 79 * 60, ((BASE, 1),)),
        PlateOption(61, "p1s", 62 * 60, ((LID, 1),)),
        PlateOption(62, "p1s", 27 * 60, ((TRAY, 1),)),
        PlateOption(63, "p1s", all_in_one_min * 60, ((LID, 1), (BASE, 1), (TRAY, 1))),
    ]


def test_overnight_one_plate_with_the_whole_box_beats_a_lid_waiting_for_the_morning():
    # The all-in-one plate takes longer than the base and lid plates together,
    # so a package of lid and base alone never picked it; overnight the lid on
    # a plate of its own waits for someone to clear the base, and the one plate
    # with all three is the better plan.
    night = datetime(2026, 11, 24, 0, 30, tzinfo=timezone.utc)
    result = plan(
        _inputs(
            [OrderNeed(10, 1)],
            now=night,
            parts=GLUED_BOX,
            options=_box_plates(165),
            printers=[PlannerPrinter(1, "p1s", night), PlannerPrinter(2, "p1s", night)],
            ready_after=_staffed_7_to_19,
        )
    )
    assert [p.option.id for p in result.plates] == [63]
    assert result.packing == "whole"
    assert set(result.alternatives) == {"cheapest", "whole", "own"}
    assert result.alternatives["whole"] < result.alternatives["cheapest"]


def test_in_the_day_separate_plates_let_the_glue_dry_while_the_lid_prints():
    # The all-in-one plate is the quickest way to print the box, but the base
    # and the tray then dry after everything is printed. Base first with the
    # tray on the other printer, then the lid while they dry, is an hour sooner.
    result = plan(
        _inputs(
            [OrderNeed(10, 1)],
            parts=GLUED_BOX,
            options=_box_plates(150),
            printers=[PlannerPrinter(1, "p1s", NOW), PlannerPrinter(2, "p1s", NOW)],
        )
    )
    assert sorted(p.option.id for p in result.plates) == [60, 61, 62]
    assert result.packing == "own"
    # Base 10:00-11:19 dries until 12:19, the lid prints 11:19-12:21.
    assert result.ready_at[10] == NOW + timedelta(minutes=79 + 62)


def test_plates_of_one_part_each_are_planned_one_way_only():
    result = plan(_inputs([OrderNeed(10, 1)], h2s=False))
    assert set(result.alternatives) == {"cheapest"}
