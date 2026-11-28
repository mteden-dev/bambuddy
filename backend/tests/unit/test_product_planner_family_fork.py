"""The planner with several products at once: a family sharing mixed plates (fork).

Five magazine holders (single, double, triple, quad, gun), each a product of its
own with one part, and a mixed plate printing 2, 2, 1, 1 and 1 of them. See
services/product_planner.py.
"""

from __future__ import annotations

import random
import time
from datetime import UTC, datetime, timedelta

import pytest

from backend.app.services import product_planner as pl

NOW = datetime(2026, 11, 28, 8, tzinfo=UTC)
H = 3600
MIX = (2, 2, 1, 1, 1)
# part id -> product id
PARTS = [pl.PartSpec(i, 1, product_id=10 + i) for i in range(1, 6)]


def _options(*, dedicated: bool = True, singles: bool = False) -> list[pl.PlateOption]:
    options = [pl.PlateOption(100, "P1S", int(5.5 * H), tuple(zip(range(1, 6), MIX, strict=True)))]
    oid = 101
    if dedicated:
        for part, pieces, hours in ((1, 6, 5), (2, 4, 5), (3, 3, 5), (4, 2, 5), (5, 1, 4)):
            options.append(pl.PlateOption(oid, "P1S", hours * H, ((part, pieces),)))
            oid += 1
    if singles:
        for part in range(1, 6):
            options.append(pl.PlateOption(oid, "P1S", H, ((part, 1),)))
            oid += 1
    return options


def _inputs(units: tuple[int, ...], printers: int = 1, **kw) -> pl.PlanInputs:
    orders = [
        pl.OrderNeed(50 + part, n, NOW + timedelta(days=2), product_id=10 + part)
        for part, n in zip(range(1, 6), units, strict=True)
        if n
    ]
    return pl.PlanInputs(
        now=NOW,
        parts=PARTS,
        options=_options(**kw),
        printers=[pl.PlannerPrinter(i, "P1S", NOW) for i in range(1, printers + 1)],
        orders=orders,
        stock={},
    )


def _mixed(plan: pl.Plan) -> int:
    return sum(1 for p in plan.plates if p.option.id == 100)


def test_orders_shaped_like_the_mixed_plate_print_on_it():
    plan = pl.plan(_inputs(MIX))
    assert [p.option.id for p in plan.plates] == [100]
    assert plan.short == {} and plan.extra == {}
    # Every product's order is ready when the one plate is.
    assert set(plan.ready_at) == {51, 52, 53, 54, 55}
    assert len(set(plan.ready_at.values())) == 1


def test_four_times_the_mix_takes_four_mixed_plates():
    plan = pl.plan(_inputs(tuple(4 * n for n in MIX)))
    assert _mixed(plan) == 4 and len(plan.plates) == 4
    assert plan.short == {} and plan.extra == {}


def test_one_product_alone_takes_its_own_plate():
    plan = pl.plan(_inputs((4, 0, 0, 0, 0)))
    assert [p.option.id for p in plan.plates] == [101]
    assert set(plan.ready_at) == {51}


def test_without_plates_of_their_own_the_mix_prints_and_the_rest_is_extra():
    plan = pl.plan(_inputs((3, 1, 0, 0, 0), dedicated=False))
    assert _mixed(plan) == 2
    assert plan.short == {}
    assert plan.extra == {1: 1, 2: 3, 3: 2, 4: 2, 5: 2}


def test_each_order_is_ready_with_its_own_products_pieces():
    # Singles are on the shelf: the single's order is ready now, the double's waits for a print.
    inputs = _inputs((2, 2, 0, 0, 0))
    inputs.stock = {1: {0: 2}}
    plan = pl.plan(inputs)
    assert plan.ready_at[51] == NOW
    assert plan.ready_at[52] is not None and plan.ready_at[52] > NOW
    assert plan.short == {}


def test_what_the_orders_want_is_counted_per_product():
    inputs = _inputs((3, 1, 0, 0, 0))
    inputs.stock = {2: {0: 5}}
    assert pl._to_make(inputs, pl._have(inputs)) == {1: 3, 2: 0, 3: 0, 4: 0, 5: 0}


def test_products_planned_together_with_matched_parts_are_refused():
    inputs = _inputs((1, 1, 0, 0, 0))
    inputs.parts = [pl.PartSpec(1, 1, matched=True, product_id=11), *PARTS[1:]]
    with pytest.raises(ValueError, match="matched"):
        pl.plan(inputs)


def test_one_product_is_one_group():
    parts = [pl.PartSpec(1, 1), pl.PartSpec(2, 1)]
    assert pl.by_product(parts, [pl.OrderNeed(1, 2)]) == [(parts, [pl.OrderNeed(1, 2)])]


def test_a_big_family_plans_in_bounded_time():
    started = time.perf_counter()
    plan = pl.plan(_inputs((20, 20, 10, 10, 10), printers=4, singles=True))
    assert plan.short == {}
    assert time.perf_counter() - started < 20


# --- the split cover search ------------------------------------------------------------------


def _cost(plates, plate_cost: int) -> float:
    return sum((o.duration_s + plate_cost) * (1 + o.risk) for o in plates)


def _made(plates) -> dict[int, int]:
    made: dict[int, int] = {}
    for option in plates:
        for part, n in option.pieces:
            made[part] = made.get(part, 0) + n
    return made


def test_the_split_cover_finds_the_cheapest_like_the_full_search():
    options = _options(singles=True)
    rnd = random.Random(7)
    for _ in range(150):
        needs = tuple((part, rnd.randint(0, 6)) for part in range(1, 6))
        full = pl._cheapest_cover(options, needs, 900)
        split = pl._split_cover(options, [p for p, _ in needs], tuple(n for _, n in needs), 900)
        assert (full is None) == (split is None)
        if full is not None and split is not None:
            assert _cost(split, 900) == pytest.approx(_cost(full, 900))
            assert all(_made(split).get(part, 0) >= n for part, n in needs)


def test_big_needs_use_the_split_and_stay_fast():
    options = _options(singles=True)
    needs = ((1, 40), (2, 40), (3, 20), (4, 20), (5, 20))
    started = time.perf_counter()
    found = pl._cheapest_cover(options, needs, 900)
    assert time.perf_counter() - started < 1
    assert found is not None
    assert all(_made(found).get(part, 0) >= n for part, n in needs)


def test_many_mixed_plates_are_peeled_and_still_cover_the_needs():
    options = [
        pl.PlateOption(200 + k, "P1S", (4 + k) * H, tuple((part, 1 + (part + k) % 3) for part in range(1, 6)))
        for k in range(6)
    ] + _options(dedicated=False, singles=True)[1:]
    needs = tuple((part, 60) for part in range(1, 6))
    found = pl._cheapest_cover(options, needs, 900)
    assert found is not None
    assert all(_made(found).get(part, 0) >= 60 for part in range(1, 6))
