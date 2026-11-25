"""Which plates to print for a product's open orders, and on which printers (fork).

Pure: plain values in, plain values out; services/products.py reads the
database and the queue forecast and feeds it.

An order wants whole products, a product is parts, and a plate prints pieces
of one or more parts. Pieces are counted per printer, because the parts marked
*matched* (a lid and its base) should come from one printer for one product:
every printer prints walls a little differently. A piece whose printer is not
known (a stock correction naming none, "I have a lid already") goes with any
printer's pieces: someone put it there knowing that.

The planner:

1. counts what is missing: the open orders' products minus the pieces in stock
   or printing now, matched parts as complete sets per printer;
2. builds plans the way the queue runs them: whichever printer frees up first
   takes the next piece of work (the group with the most print time left), a
   package of at most ``cap`` products, printed with the cheapest set of plates
   for that printer's model. A package's matched parts all go on its printer,
   and the pieces that printer still has from earlier (a lid whose base failed)
   are used first. Every cap per printer model (one for matched parts, one for
   the others) gives another plan, from one product per package (spread over
   the printers) to all of them at once. Each plan is tried a second time with
   every printer's plates of parts that need work after printing (a base and
   a tray glued together) moved before the rest, so the glue can dry while
   the lid prints. When a plate prints several parts, each plan is built three
   ways: every package on its cheapest plates for its own parts (the default),
   every package covering whole products (its other parts too, so a plate
   printing a lid, its base and the tray together counts for all three), and
   every package on plates printing its own parts only (so the tray can print
   on another printer while the base dries);
3. scores each plan and keeps the cheapest: how long until each order can be
   picked up (its last print's end, moved to when someone clears the plate),
   lateness against due dates, a cost per plate, and pieces made beyond the
   orders.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from itertools import product as cartesian

# Pieces whose printer is not known (a stock correction that names none).
UNKNOWN_PRINTER = 0
# A minute past the due date costs as much as this many minutes of waiting.
LATE_WEIGHT = 4.0
# Stands in for the wait of an order no printer can finish.
NEVER = timedelta(days=30)
# A piece made beyond the orders costs this share of its print time.
EXTRA_PIECE_WEIGHT = 0.25
# Caps tried per printer model, up to the products wanted.
CAP_STEPS = (1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64)
# Every cap combination is tried up to this many, each built twice; above it
# the caps are tuned one at a time.
MAX_CAP_COMBINATIONS = 1000
# How a package's plates are chosen (see ``_build``).
PACK_CHEAPEST = "cheapest"
PACK_WHOLE = "whole"
PACK_OWN = "own"

# part id -> printer id -> pieces
Pool = dict[int, dict[int, int]]
Pieces = tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class PartSpec:
    id: int
    # Pieces of it one product takes.
    per_unit: int
    # Comes from the same printer as the product's other matched parts.
    matched: bool = False
    # Work on a printed piece before the product is done (a tray glued into
    # the base drying), in seconds: the piece counts as there that much later.
    finish_s: int = 0


@dataclass(frozen=True)
class PlannerPrinter:
    id: int
    # Model key, the form PlateOption.model uses.
    model: str
    # When it is done with what is queued before this product's jobs.
    free_at: datetime


@dataclass(frozen=True)
class PlateOption:
    """A plate the planner may print: a product plate on its file's model."""

    id: int
    model: str
    duration_s: int
    # (part id, pieces), in part order.
    pieces: Pieces
    # The printers of the model it may go on (printer tags); None for all.
    printers: frozenset[int] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "_counts", dict(self.pieces))

    def count(self, part_id: int) -> int:
        return self._counts.get(part_id, 0)  # type: ignore[attr-defined]

    def runs_on(self, printer: PlannerPrinter) -> bool:
        return self.model == printer.model and (self.printers is None or printer.id in self.printers)


@dataclass(frozen=True)
class OrderNeed:
    id: int
    units: int
    due: datetime | None = None


@dataclass(frozen=True)
class Arrival:
    """Pieces that are, or will be, there to take from a printer."""

    at: datetime
    printer_id: int
    pieces: Pieces
    # Already finished (stock): no finishing time on top.
    finished: bool = False


@dataclass
class Allocation:
    # order id -> complete products it has
    units: dict[int, int]
    # order id -> part id -> pieces counted for it, complete products and the
    # rest of what is there, in order
    pieces: dict[int, dict[int, int]]
    # order id -> the pieces of its complete products
    taken: dict[int, Pool]
    # What no order took.
    left: Pool


@dataclass
class PlannedPlate:
    option: PlateOption
    printer_id: int
    start: datetime
    end: datetime
    # When someone can take the pieces off (the plate is cleared).
    ready: datetime
    # Prints matched parts: stays on its printer.
    pinned: bool


@dataclass
class Plan:
    plates: list[PlannedPlate]
    # order id -> when all of it can be picked up; None when nothing can make it
    ready_at: dict[int, datetime | None]
    cost: float
    # part id -> pieces no printer can make (no plate for its model)
    short: dict[int, int] = field(default_factory=dict)
    # part id -> pieces made beyond the orders
    extra: dict[int, int] = field(default_factory=dict)
    # (model, "matched" or "loose") -> the most products one package holds
    caps: dict[tuple[str, str], int] = field(default_factory=dict)
    # How its packages chose plates (PACK_*).
    packing: str = PACK_CHEAPEST
    # Packing -> the cheapest plan's cost built that way, for the log.
    alternatives: dict[str, float] = field(default_factory=dict)


@dataclass
class PlanInputs:
    now: datetime
    parts: list[PartSpec]
    options: list[PlateOption]
    # In the order an "Any" job picks among free printers (ties go to the first).
    printers: list[PlannerPrinter]
    # Open orders in the order they share the stock.
    orders: list[OrderNeed]
    # Pieces there now.
    stock: Pool
    # Pieces printing now, with when they will be there.
    arriving: list[Arrival] = field(default_factory=list)
    # What one more plate costs, in seconds of waiting (work, a plate change).
    plate_cost_s: int = 900
    # When a print ending at a given time is cleared and its printer can go on;
    # None when nobody needs to.
    ready_after: Callable[[datetime], datetime] | None = None


# --- pools -------------------------------------------------------------------


def pool_add(pool: Pool, printer_id: int, pieces: Iterable[tuple[int, int]]) -> None:
    for part_id, n in pieces:
        if n:
            by_printer = pool.setdefault(part_id, {})
            by_printer[printer_id] = by_printer.get(printer_id, 0) + n


def _copy(pool: Pool) -> Pool:
    return {part_id: dict(by_printer) for part_id, by_printer in pool.items()}


def _total(pool: Pool, part_id: int) -> int:
    return sum(n for n in pool.get(part_id, {}).values() if n > 0)


def _take(pool: Pool, into: Pool, part_id: int, printer_id: int, n: int) -> None:
    pool[part_id][printer_id] -= n
    pool_add(into, printer_id, ((part_id, n),))


def _sets(pool: Pool, matched: Sequence[PartSpec], printer_id: int) -> int:
    return min(max(0, pool.get(m.id, {}).get(printer_id, 0)) // m.per_unit for m in matched)


def _printers_holding(pool: Pool, parts: Sequence[PartSpec]) -> list[int]:
    return sorted({r for p in parts for r, n in pool.get(p.id, {}).items() if n > 0})


def _known_printers_holding(pool: Pool, parts: Sequence[PartSpec]) -> list[int]:
    return [r for r in _printers_holding(pool, parts) if r != UNKNOWN_PRINTER]


def _completes(pool: Pool, matched: Sequence[PartSpec], printer_id: int) -> bool:
    """Whether the matched pieces left on a printer make a product with pieces of no known printer."""
    there = {m.id: max(0, pool.get(m.id, {}).get(printer_id, 0)) for m in matched}
    if not any(there.values()):
        return False
    return all(there[m.id] + max(0, pool.get(m.id, {}).get(UNKNOWN_PRINTER, 0)) >= m.per_unit for m in matched)


def _take_completed(pool: Pool, into: Pool, matched: Sequence[PartSpec], printer_id: int) -> None:
    """One product's matched pieces: the printer's own first, the rest of no known printer."""
    for m in matched:
        own = min(m.per_unit, max(0, pool.get(m.id, {}).get(printer_id, 0)))
        if own:
            _take(pool, into, m.id, printer_id, own)
        if m.per_unit - own:
            _take(pool, into, m.id, UNKNOWN_PRINTER, m.per_unit - own)


def _matched_units(pool: Pool, matched: Sequence[PartSpec]) -> int:
    """Whole sets of the matched parts: per printer, then completed with pieces of no known printer.

    The order ``allocate`` takes them in: each printer's own sets, then the
    printers' leftovers completed (printer by printer), then sets made only of
    pieces of no known printer.
    """
    work = {m.id: dict(pool.get(m.id, {})) for m in matched}
    units = 0
    known = _known_printers_holding(work, matched)
    for printer_id in known:
        sets = _sets(work, matched, printer_id)
        units += sets
        for m in matched:
            if sets:
                work[m.id][printer_id] -= sets * m.per_unit
    for printer_id in known:
        while _completes(work, matched, printer_id):
            _take_completed(work, {}, matched, printer_id)
            units += 1
    return units + _sets(work, matched, UNKNOWN_PRINTER)


# --- sharing the stock between orders ------------------------------------------


def allocate(parts: Sequence[PartSpec], pool: Pool, orders: Sequence[OrderNeed]) -> Allocation:
    """Give the pieces in ``pool`` to ``orders``, in order, as complete products.

    A product takes its matched parts from one printer, the one with the most
    complete sets; when no printer has a whole set, a printer's leftovers
    completed with pieces of no known printer, and last sets of those pieces
    alone. The other parts come from wherever there are most. What is left is
    then counted towards the orders still short, in order, for progress.
    """
    left = _copy(pool)
    matched = [p for p in parts if p.matched]
    loose = [p for p in parts if not p.matched]
    units: dict[int, int] = {}
    taken: dict[int, Pool] = {}
    for order in orders:
        got = 0
        took: Pool = {}
        while got < order.units:
            if any(_total(left, p.id) < p.per_unit for p in loose):
                break
            if matched:
                best = None
                best_sets = 0
                for printer_id in _known_printers_holding(left, matched):
                    sets = _sets(left, matched, printer_id)
                    if sets > best_sets:
                        best, best_sets = printer_id, sets
                if best is not None:
                    for m in matched:
                        _take(left, took, m.id, best, m.per_unit)
                else:
                    completing = next(
                        (r for r in _known_printers_holding(left, matched) if _completes(left, matched, r)), None
                    )
                    if completing is not None:
                        _take_completed(left, took, matched, completing)
                    elif _sets(left, matched, UNKNOWN_PRINTER):
                        for m in matched:
                            _take(left, took, m.id, UNKNOWN_PRINTER, m.per_unit)
                    else:
                        break
            for p in loose:
                for _ in range(p.per_unit):
                    holding = left[p.id]
                    printer_id = max((r for r, n in holding.items() if n > 0), key=lambda r: (holding[r], -r))
                    _take(left, took, p.id, printer_id, 1)
            got += 1
        units[order.id] = got
        taken[order.id] = took

    rest = {p.id: _total(left, p.id) for p in parts}
    pieces: dict[int, dict[int, int]] = {}
    for order in orders:
        counted = {}
        for p in parts:
            done = units[order.id] * p.per_unit
            more = min(rest[p.id], (order.units - units[order.id]) * p.per_unit)
            rest[p.id] -= more
            counted[p.id] = done + more
        pieces[order.id] = counted
    return Allocation(units=units, pieces=pieces, taken=taken, left=left)


def complete_units(parts: Sequence[PartSpec], pool: Pool) -> int:
    """How many whole products ``pool`` makes: what ``allocate`` hands out in all.

    Matched sets are counted per printer (completed with pieces of no known
    printer) and the other parts over all printers, so taking products one at
    a time, as ``allocate`` does, can only stop at this number.
    """
    matched = [p for p in parts if p.matched]
    loose = [p for p in parts if not p.matched]
    if not parts:
        return 0
    units = math.inf
    if matched:
        units = _matched_units(pool, matched)
    for part in loose:
        units = min(units, _total(pool, part.id) // part.per_unit)
    return int(units)


def ready_times(
    parts: Sequence[PartSpec], orders: Sequence[OrderNeed], arrivals: Iterable[Arrival], now: datetime
) -> dict[int, datetime | None]:
    """When each order has all its products, as ``arrivals`` come in (None: never).

    Orders take whole products in order, so order k is complete once the pool
    makes as many products as orders 1..k want together. A printed piece
    counts once its part's finishing time has passed too.
    """
    ready: dict[int, datetime | None] = {o.id: None for o in orders}
    wanted_by = []
    total = 0
    for order in orders:
        total += order.units
        wanted_by.append((order.id, total))
    finish = {p.id: timedelta(seconds=p.finish_s) for p in parts}
    events: list[tuple[datetime, int, int, int]] = []
    for arrival in arrivals:
        for part_id, n in arrival.pieces:
            delay = timedelta(0) if arrival.finished else finish.get(part_id, timedelta(0))
            events.append((arrival.at + delay, arrival.printer_id, part_id, n))
    events.sort(key=lambda e: e[0])
    pool: Pool = {}
    i = 0
    next_order = 0
    while i < len(events) and next_order < len(wanted_by):
        at = events[i][0]
        while i < len(events) and events[i][0] == at:
            pool_add(pool, events[i][1], ((events[i][2], events[i][3]),))
            i += 1
        units = complete_units(parts, pool)
        while next_order < len(wanted_by) and units >= wanted_by[next_order][1]:
            ready[wanted_by[next_order][0]] = max(at, now)
            next_order += 1
    return ready


def stock_arrivals(stock: Pool, now: datetime) -> list[Arrival]:
    return [
        Arrival(now, printer_id, ((part_id, n),), finished=True)
        for part_id, by_printer in stock.items()
        for printer_id, n in by_printer.items()
        if n > 0
    ]


# --- choosing plates -----------------------------------------------------------


def _cheapest_cover(
    options: Sequence[PlateOption], needs: tuple[tuple[int, int], ...], plate_cost_s: int
) -> tuple[PlateOption, ...] | None:
    """The plates (repeats allowed) that print at least ``needs`` in the least time.

    Each plate also costs ``plate_cost_s``; between equal costs the one making
    fewer pieces beyond ``needs`` wins. None when some part has no plate.
    """
    part_ids = [pid for pid, _ in needs]
    start = tuple(max(0, n) for _, n in needs)
    if not any(start):
        return ()
    for pid, n in zip(part_ids, start, strict=True):
        if n and not any(o.count(pid) for o in options):
            return None
    counts = [(o, tuple(o.count(pid) for pid in part_ids)) for o in options]
    memo: dict[tuple[int, ...], tuple[float, int, tuple[PlateOption, ...]] | None] = {}

    def best(rem: tuple[int, ...]) -> tuple[float, int, tuple[PlateOption, ...]] | None:
        if not any(rem):
            return (0.0, 0, ())
        if rem in memo:
            return memo[rem]
        result = None
        for option, got in counts:
            if not any(c and r for c, r in zip(got, rem, strict=True)):
                continue
            sub = best(tuple(max(0, r - c) for r, c in zip(rem, got, strict=True)))
            if sub is None:
                continue
            extra = sum(max(0, c - r) for c, r in zip(got, rem, strict=True))
            candidate = (sub[0] + option.duration_s + plate_cost_s, sub[1] + extra, (option, *sub[2]))
            if result is None or candidate[:2] < result[:2]:
                result = candidate
        memo[rem] = result
        return result

    found = best(start)
    if found is None:
        return None
    order = {o.id: i for i, o in enumerate(options)}
    return tuple(sorted(found[2], key=lambda o: order[o.id]))


class _Covers:
    """``_cheapest_cover`` per printer's usable plates, remembered across plans."""

    def __init__(self, inputs: PlanInputs, matched_ids: frozenset[int]):
        self._inputs = inputs
        self._matched_ids = matched_ids
        self._usable: dict[tuple[int, bool], tuple[tuple[PlateOption, ...], tuple[int, ...]]] = {}
        self._memo: dict[tuple, tuple[PlateOption, ...] | None] = {}

    def _usable_on(self, printer: PlannerPrinter, matched: bool) -> tuple[tuple[PlateOption, ...], tuple[int, ...]]:
        key = (printer.id, matched)
        if key not in self._usable:
            usable = tuple(
                o
                for o in self._inputs.options
                if o.runs_on(printer) and (matched or not any(o.count(m) for m in self._matched_ids))
            )
            self._usable[key] = (usable, tuple(o.id for o in usable))
        return self._usable[key]

    def cover(
        self, printer: PlannerPrinter, needs: tuple[tuple[int, int], ...], *, matched: bool, own: bool = False
    ) -> tuple[PlateOption, ...] | None:
        """The cheapest plates for ``needs``; ``own``: only plates printing nothing else."""
        usable, ids = self._usable_on(printer, matched)
        if own:
            wanted = {pid for pid, _ in needs}
            usable = tuple(o for o in usable if all(pid in wanted for pid, n in o.pieces if n))
            ids = tuple(o.id for o in usable)
        key = (ids, needs)
        if key not in self._memo:
            self._memo[key] = _cheapest_cover(usable, needs, self._inputs.plate_cost_s)
        return self._memo[key]


def _piece_times(inputs: PlanInputs) -> dict[int, float]:
    """The shortest print time per piece of each part, over all its plates."""
    times: dict[int, float] = {}
    for option in inputs.options:
        for part_id, n in option.pieces:
            if n > 0:
                per_piece = option.duration_s / n
                times[part_id] = min(times.get(part_id, per_piece), per_piece)
    return times


Caps = dict[tuple[str, str], int]


def _cap_values(inputs: PlanInputs, wanted: int) -> list[int]:
    """The package sizes worth trying: up to twice the products the fullest plate makes.

    A bigger package is only the same plates again on one printer, which a
    smaller cap gets too, one package after the other.
    """
    per_unit = {p.id: p.per_unit for p in inputs.parts}
    fullest = max(
        (max(n / per_unit.get(pid, 1) for pid, n in o.pieces) for o in inputs.options if o.pieces),
        default=1,
    )
    top = max(1, min(wanted, math.ceil(2 * fullest)))
    return sorted({c for c in CAP_STEPS if c < top} | {top})


def _build(
    inputs: PlanInputs, caps: Caps, use_leftovers_first: bool, covers: _Covers, packing: str = PACK_CHEAPEST
) -> Plan:
    """One plan for ``caps``.

    ``packing`` chooses a package's plates. PACK_CHEAPEST: the cheapest for the
    group's own parts, a plate printing other parts too costed as if they were
    waste. PACK_WHOLE: the package covers whole products, the parts still
    missing for its products besides the group's own, and the matched group
    goes first. PACK_OWN: only plates printing nothing but the group's parts.
    """
    whole = packing == PACK_WHOLE
    own = packing == PACK_OWN
    now = inputs.now
    matched = [p for p in inputs.parts if p.matched]
    loose = [p for p in inputs.parts if not p.matched]
    wanted = sum(o.units for o in inputs.orders)

    have = _copy(inputs.stock)
    for arrival in inputs.arriving:
        pool_add(have, arrival.printer_id, arrival.pieces)

    # Matched parts: complete sets already there per printer, and the pieces
    # left over on each (a lid without its base). Pieces of no known printer
    # complete leftovers first; what is left of them (``wild``) goes into the
    # first packages that can use it, on any printer.
    leftover: Pool = {m.id: {} for m in matched}
    wild = {m.id: 0 for m in matched}
    missing_units = 0
    if matched:
        work = {m.id: {r: n for r, n in have.get(m.id, {}).items() if n > 0} for m in matched}
        sets_there = _matched_units(work, matched)
        known = _known_printers_holding(work, matched)
        for printer_id in known:
            sets = _sets(work, matched, printer_id)
            for m in matched:
                if sets:
                    work[m.id][printer_id] -= sets * m.per_unit
        for printer_id in known:
            while _completes(work, matched, printer_id):
                _take_completed(work, {}, matched, printer_id)
        alone = _sets(work, matched, UNKNOWN_PRINTER)
        for m in matched:
            wild[m.id] = max(0, work[m.id].get(UNKNOWN_PRINTER, 0)) - alone * m.per_unit
            for printer_id in known:
                leftover[m.id][printer_id] = max(0, work[m.id].get(printer_id, 0))
        missing_units = max(0, wanted - sets_there)
    missing = {p.id: wanted * p.per_unit - _total(have, p.id) for p in loose}
    to_make = {m.id: missing_units * m.per_unit for m in matched} | {p: max(0, n) for p, n in missing.items()}

    free = {p.id: max(p.free_at, now) for p in inputs.printers}
    rank = {p.id: i for i, p in enumerate(inputs.printers)}
    plates: list[PlannedPlate] = []
    made: dict[int, int] = {}
    piece_time = _piece_times(inputs)

    finish_of = {p.id: p.finish_s for p in inputs.parts}

    def finishing(option: PlateOption) -> int:
        return max((finish_of.get(part_id, 0) for part_id, _ in option.pieces), default=0)

    def schedule(printer: PlannerPrinter, chosen: tuple[PlateOption, ...], pinned: bool) -> None:
        # Pieces that still need work after printing (a base to glue a tray
        # into) go first; the rest prints while they dry.
        for option in sorted(chosen, key=lambda o: -finishing(o)):
            start = free[printer.id]
            end = start + timedelta(seconds=option.duration_s)
            ready = max(end, inputs.ready_after(end)) if inputs.ready_after is not None else end
            plates.append(PlannedPlate(option, printer.id, start, end, ready, pinned))
            free[printer.id] = ready
            for part_id, n in option.pieces:
                made[part_id] = made.get(part_id, 0) + n
                if part_id in missing:
                    missing[part_id] -= n

    def loose_needs(units: float, skip: int | None = None) -> tuple[tuple[int, int], ...]:
        """The loose parts still missing for ``units`` products (``whole`` packages)."""
        return tuple(
            (p.id, max(0, min(missing[p.id], math.ceil(units * p.per_unit))))
            for p in loose
            if p.id != skip and missing[p.id] > 0
        )

    def matched_package(printer: PlannerPrinter, units: int) -> tuple[PlateOption, ...] | None:
        needs = tuple(
            (m.id, max(0, units * m.per_unit - leftover[m.id].get(printer.id, 0) - wild[m.id])) for m in matched
        )
        if whole:
            needs += loose_needs(units)
        return covers.cover(printer, needs, matched=True, own=own)

    def take_matched(printer: PlannerPrinter, units: int, chosen: tuple[PlateOption, ...]) -> None:
        nonlocal missing_units
        for m in matched:
            produced = sum(o.count(m.id) for o in chosen)
            own = leftover[m.id].get(printer.id, 0)
            from_wild = min(wild[m.id], max(0, units * m.per_unit - own - produced))
            wild[m.id] -= from_wild
            leftover[m.id][printer.id] = own + produced + from_wild - units * m.per_unit
        missing_units -= units

    if use_leftovers_first and missing_units:
        for printer in sorted(inputs.printers, key=lambda p: (free[p.id], rank[p.id])):
            started = max(math.ceil(leftover[m.id].get(printer.id, 0) / m.per_unit) for m in matched)
            units = min(started, missing_units)
            if units <= 0:
                continue
            chosen = matched_package(printer, units)
            if chosen is None:
                continue
            schedule(printer, chosen, True)
            take_matched(printer, units, chosen)

    def finish(printer: PlannerPrinter, chosen: tuple[PlateOption, ...]) -> datetime:
        at = free[printer.id]
        for option in chosen:
            end = at + timedelta(seconds=option.duration_s)
            at = max(end, inputs.ready_after(end)) if inputs.ready_after is not None else end
        return at

    while missing_units > 0 or any(n > 0 for n in missing.values()):
        # The group with the most print time left goes first (matched parts on
        # a tie), on the printer that has a package of it ready soonest per
        # product: a faster or bigger printer free a little later may win.
        # With ``whole`` packages the matched group goes first: its packages
        # take the loose parts along.
        groups: list[tuple[int, float, int, int, str, int]] = []
        if missing_units > 0:
            left_s = missing_units * sum(m.per_unit * piece_time.get(m.id, 0.0) for m in matched)
            left_s += max(m.finish_s for m in matched)
            groups.append((int(whole), left_s, 1, 0, "matched", 0))
        for index, part in enumerate(loose):
            if missing[part.id] > 0:
                left_s = missing[part.id] * piece_time.get(part.id, 0.0) + part.finish_s
                groups.append((0, left_s, 0, -index, "loose", part.id))
        groups.sort(reverse=True)
        placed = False
        for *_, kind, part_id in groups:
            best_key = None
            best = None
            for printer in inputs.printers:
                cap = caps.get((printer.model, kind), wanted) or wanted
                if kind == "matched":
                    units = min(missing_units, cap)
                    chosen = matched_package(printer, units)
                    products = float(units)
                else:
                    part = next(p for p in loose if p.id == part_id)
                    target = min(missing[part_id], cap * part.per_unit)
                    products = target / part.per_unit
                    needs = ((part_id, target),)
                    if whole:
                        needs += loose_needs(products, skip=part_id)
                    chosen = covers.cover(printer, needs, matched=False, own=own)
                    units = target
                if chosen is None or (not chosen and kind != "matched"):
                    continue
                done_at = finish(printer, chosen)
                key = ((done_at - now).total_seconds() / products, done_at, rank[printer.id])
                if best_key is None or key < best_key:
                    best_key, best = key, (printer, units, chosen)
            if best is None:
                continue
            printer, units, chosen = best
            schedule(printer, chosen, kind == "matched")
            if kind == "matched":
                take_matched(printer, units, chosen)
            placed = True
            break
        if not placed:
            break

    short = {m.id: missing_units * m.per_unit for m in matched if missing_units > 0}
    short |= {part_id: n for part_id, n in missing.items() if n > 0}
    extra = {part_id: n - to_make.get(part_id, 0) for part_id, n in made.items() if n - to_make.get(part_id, 0) > 0}
    fixed_cost = inputs.plate_cost_s * len(plates)
    fixed_cost += sum(EXTRA_PIECE_WEIGHT * n * piece_time.get(part_id, 0.0) for part_id, n in extra.items())
    start_of = {p.id: max(p.free_at, now) for p in inputs.printers}

    def score(candidate: list[PlannedPlate]) -> tuple[float, dict[int, datetime | None]]:
        arrivals = stock_arrivals(inputs.stock, now) + list(inputs.arriving)
        arrivals += [Arrival(p.ready, p.printer_id, p.option.pieces) for p in candidate]
        ready_at = ready_times(inputs.parts, inputs.orders, arrivals, now)
        cost = fixed_cost
        for order in inputs.orders:
            ready = ready_at[order.id]
            finished = ready if ready is not None else now + NEVER
            cost += (finished - now).total_seconds()
            if order.due is not None and finished > order.due:
                cost += LATE_WEIGHT * (finished - order.due).total_seconds()
        return cost, ready_at

    def drying_first(candidate: list[PlannedPlate]) -> list[PlannedPlate] | None:
        """Every printer's plates that need work after printing moved first; None when nothing moves."""
        by_printer: dict[int, list[PlannedPlate]] = {}
        for planned in candidate:
            by_printer.setdefault(planned.printer_id, []).append(planned)
        moved = False
        result: list[PlannedPlate] = []
        for printer_id, own in by_printer.items():
            order = sorted(own, key=lambda p: -finishing(p.option))
            if order == own:
                result.extend(own)
                continue
            moved = True
            at = start_of[printer_id]
            for planned in order:
                end = at + timedelta(seconds=planned.option.duration_s)
                ready = max(end, inputs.ready_after(end)) if inputs.ready_after is not None else end
                result.append(PlannedPlate(planned.option, printer_id, at, end, ready, planned.pinned))
                at = ready
        return result if moved else None

    cost, ready_at = score(plates)
    if finish_of and any(finish_of.values()):
        resequenced = drying_first(plates)
        if resequenced is not None:
            other_cost, other_ready = score(resequenced)
            if other_cost < cost:
                plates, cost, ready_at = resequenced, other_cost, other_ready
    used_caps = {
        key: cap
        for key, cap in caps.items()
        if any(p.option.model == key[0] and p.pinned == (key[1] == "matched") for p in plates)
    }
    return Plan(plates=plates, ready_at=ready_at, cost=cost, short=short, extra=extra, caps=used_caps, packing=packing)


def plan(inputs: PlanInputs) -> Plan:
    """The cheapest plan for ``inputs`` (see the module docstring).

    Every combination of caps is tried when there are few; otherwise the best
    single cap for all, then each cap in turn with the others held (twice).
    """
    wanted = sum(o.units for o in inputs.orders)
    matched_ids = frozenset(p.id for p in inputs.parts if p.matched)
    covers = _Covers(inputs, matched_ids)
    models = sorted({p.model for p in inputs.printers if any(o.runs_on(p) for o in inputs.options)})
    has_loose = len(matched_ids) < len(inputs.parts)
    kinds = [kind for kind, present in (("matched", bool(matched_ids)), ("loose", has_loose)) if present]
    keys = [(model, kind) for model in models for kind in kinds]
    values = _cap_values(inputs, max(1, wanted))
    tried: dict[tuple, Plan] = {}

    # The packings only differ when a plate prints several parts.
    multi = any(sum(1 for _, n in o.pieces if n) > 1 for o in inputs.options)
    packings = (PACK_CHEAPEST, PACK_WHOLE, PACK_OWN) if multi else (PACK_CHEAPEST,)

    alternatives: dict[str, float] = {}

    def best_of(caps: Caps) -> Plan:
        signature = tuple(sorted(caps.items()))
        if signature not in tried:
            builds = [_build(inputs, caps, first, covers, packing) for packing in packings for first in (True, False)]
            for build in builds:
                alternatives[build.packing] = min(alternatives.get(build.packing, math.inf), build.cost)
            tried[signature] = min(builds, key=lambda p: (p.cost, len(p.plates)))
        return tried[signature]

    def better(a: Plan, b: Plan | None) -> bool:
        return b is None or (a.cost, len(a.plates)) < (b.cost, len(b.plates))

    best: Plan | None = None
    best_caps: Caps = {}
    if len(values) ** len(keys) <= MAX_CAP_COMBINATIONS:
        for combo in cartesian(values, repeat=len(keys)):
            caps = dict(zip(keys, combo, strict=True))
            candidate = best_of(caps)
            if better(candidate, best):
                best, best_caps = candidate, caps
    else:
        for value in values:
            caps = dict.fromkeys(keys, value)
            candidate = best_of(caps)
            if better(candidate, best):
                best, best_caps = candidate, caps
        for _ in range(2):
            for key in keys:
                for value in values:
                    caps = {**best_caps, key: value}
                    candidate = best_of(caps)
                    if better(candidate, best):
                        best, best_caps = candidate, caps
    assert best is not None  # there is always at least one cap combination
    best.alternatives = dict(alternatives)
    return best
