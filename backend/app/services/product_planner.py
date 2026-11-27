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
   orders;
4. improves the cheapest few plans by local search scored by that same cost
   (``_improve``), because step 2 chooses plates by print time and never sees
   the clock: a printer free at night is better off with one long plate that
   runs until morning than three short ones that wait for someone, and a
   package's long plate belongs last in the day, not first. Moves: some of a
   printer's plates swapped for others printing at least the same pieces
   (or what is still wanted), a plate moved along its printer's queue, a
   plate printing no matched part moved to another printer. Every candidate
   is re-timed and re-scored in full and taken only when cheaper; the
   search is bounded (``IMPROVE_*``).

A plate may fail (``PlateOption.risk``, the chance of it, from the caller):
its print time and plate cost then count ``1 + risk`` times, in choosing a
package's plates and in a plan's cost.

Filament, when the caller knows it (``PlanInputs.filament_use`` and
``filament_left``): each printer's spools are followed plate by plate from what
its queued work leaves on them. A plate whose filament (type and colour) no
spool on the printer holds, or whose spool would run out first (the check's
margin included), starts only once someone is there to load or change it, and
that takes ``swap_s``; the spool is then a full one. So a printer with the
right filament wins unless another is done much sooner all the same.

A *preference* (someone would rather a plate printed on a given printer) is a
nudge, not a pin: in the "who is done first" comparison the preferred printer
counts as done ``max(prefer_min_s, prefer_pct % of the package's print time)``
sooner, and a plan that puts the plate elsewhere costs that much more. Another
printer wins only when it is done sooner by more than that, or when the
preferred one needs a spool loaded or changed for the plate and it does not.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
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
# The improvement pass (``_improve``) stops after this many accepted moves, or
# once it has scored this many candidates: it is bounded and deterministic.
IMPROVE_MAX_MOVES = 100
IMPROVE_MAX_TRIES = 1500
# How many of the enumeration's cheapest plans are improved.
IMPROVE_PLANS = 3
# How a package's plates are chosen (see ``_build``).
PACK_CHEAPEST = "cheapest"
PACK_WHOLE = "whole"
PACK_OWN = "own"
# Why a plate is not on the printer someone preferred for it.
OVERRULED_EARLIER = "earlier"  # another is done sooner by more than the margin
OVERRULED_FILAMENT = "filament"  # the preferred one needs a spool loaded or changed, another does not
OVERRULED_UNAVAILABLE = "unavailable"  # the preferred one cannot print it now (offline, other plates)
OVERRULED_PIECES = "pieces"  # the set's other pieces are on another printer already
# A spool loaded for a plate (no spool held its filament) or changed (it ran out first).
SWAP_LOAD = "load"
SWAP_CHANGE = "change"

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
    # The chance (0..1) that a print of it fails: its time and plate cost
    # count ``1 + risk`` times wherever plates are costed.
    risk: float = 0.0

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


@dataclass(frozen=True)
class FilamentUse:
    """One filament a plate prints with on a given printer."""

    type: str
    # "#rrggbb"; with the type it says which spool serves it.
    color: str
    grams: float
    # The tray (global tray id) it takes on that printer; None when no tray
    # holds it: someone has to load it.
    tray: int | None = None

    @property
    def key(self) -> str:
        return f"{self.type.strip().upper()}|{self.color.strip().lower()}"


@dataclass(frozen=True)
class FilamentNote:
    """What a planned plate takes of one filament, and what is left after it."""

    type: str
    color: str
    grams: float
    tray: int | None
    # Grams left on the spool after the plate; None when the amount is not known.
    left: float | None
    # SWAP_LOAD or SWAP_CHANGE when someone has to before the plate, else None.
    swap: str | None = None


@dataclass(frozen=True)
class Preference:
    """A printer someone would rather a plate printed on: a nudge, not a pin."""

    printer_id: int
    plate_id: int
    # The parts the plate prints: a plan printing them with another plate of
    # the printer's model (more pieces at once) carries the preference too.
    parts: frozenset[int]


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
    # The filament it takes on its printer (when known).
    filament: tuple[FilamentNote, ...] = ()
    # Someone loads (SWAP_LOAD) or changes (SWAP_CHANGE) a spool before it.
    swap: str | None = None
    # The printer someone preferred for it, and why it is elsewhere (OVERRULED_*).
    preferred: int | None = None
    overruled: str | None = None
    # With OVERRULED_EARLIER: how much sooner its printer is done.
    overruled_by_s: int = 0


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
    # The part of ``cost`` that is overruled preferences.
    preference_s: float = 0.0


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
    # Plate id -> printer id -> the filament the plate takes there. A printer
    # missing from it is not known (no status): nothing is checked there.
    filament_use: Mapping[int, Mapping[int, tuple[FilamentUse, ...]]] = field(default_factory=dict)
    # Printer id -> tray -> grams left once the work queued before this
    # product is done; a tray missing from it holds an unknown amount.
    filament_left: Mapping[int, Mapping[int, float]] = field(default_factory=dict)
    # A spool must hold this much more than a plate takes (the check's margin).
    filament_margin_pct: float = 0.0
    # Loading or changing a spool takes this long, once someone is there.
    swap_s: int = 600
    # The first moment someone is there from a given time; None: always.
    staffed_at: Callable[[datetime], datetime] | None = None
    # What a fresh spool holds.
    full_spool_g: float = 1000.0
    # Printers someone prefers for plates, and how much sooner another must be done to win.
    preferences: list[Preference] = field(default_factory=list)
    prefer_min_s: int = 1800
    prefer_pct: float = 25.0


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
    finish = {p.id: timedelta(seconds=p.finish_s) for p in parts}
    events: list[tuple[datetime, int, int, int]] = []
    for arrival in arrivals:
        for part_id, n in arrival.pieces:
            delay = timedelta(0) if arrival.finished else finish.get(part_id, timedelta(0))
            events.append((arrival.at + delay, arrival.printer_id, part_id, n))
    return _ready_from_events(parts, orders, events, now)


def _ready_from_events(
    parts: Sequence[PartSpec], orders: Sequence[OrderNeed], events: list[tuple[datetime, int, int, int]], now: datetime
) -> dict[int, datetime | None]:
    """``ready_times`` from (when there, printer id, part id, pieces), finishing time included."""
    ready: dict[int, datetime | None] = {o.id: None for o in orders}
    wanted_by = []
    total = 0
    for order in orders:
        total += order.units
        wanted_by.append((order.id, total))
    events.sort(key=lambda e: e[0])
    pool: Pool = {}
    # Pieces per part over all printers: a cheap upper bound on the products,
    # so the full count runs only when the next order could be complete.
    totals = {p.id: 0 for p in parts}
    i = 0
    next_order = 0
    while i < len(events) and next_order < len(wanted_by):
        at = events[i][0]
        while i < len(events) and events[i][0] == at:
            pool_add(pool, events[i][1], ((events[i][2], events[i][3]),))
            if events[i][2] in totals:
                totals[events[i][2]] += max(0, events[i][3])
            i += 1
        if parts and min(totals[p.id] // p.per_unit for p in parts) < wanted_by[next_order][1]:
            continue
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

    Each plate also costs ``plate_cost_s``, and both count ``1 + risk`` times
    (a failed print is printed again); between equal costs the one making
    fewer pieces beyond ``needs`` wins. None when some part has no plate.
    """
    part_ids = [pid for pid, _ in needs]
    start = tuple(max(0, n) for _, n in needs)
    if not any(start):
        return ()
    for pid, n in zip(part_ids, start, strict=True):
        if n and not any(o.count(pid) for o in options):
            return None
    counts = [
        (o, tuple(o.count(pid) for pid in part_ids), (o.duration_s + plate_cost_s) * (1 + o.risk)) for o in options
    ]
    # rem -> (cost, extra pieces, plate printed first, what is left after it); None: no cover.
    memo: dict[tuple[int, ...], tuple[float, int, PlateOption | None, tuple[int, ...]] | None] = {}
    done = tuple(0 for _ in part_ids)
    memo[done] = (0.0, 0, None, done)

    def best(rem: tuple[int, ...]) -> tuple[float, int, PlateOption | None, tuple[int, ...]] | None:
        if rem in memo:
            return memo[rem]
        result = None
        for option, got, cost in counts:
            hit = False
            extra = 0
            left = []
            for c, r in zip(got, rem, strict=True):
                if c and r:
                    hit = True
                if r > c:
                    left.append(r - c)
                else:
                    left.append(0)
                    extra += c - r
            if not hit:
                continue
            after = tuple(left)
            sub = best(after)
            if sub is None:
                continue
            candidate = (sub[0] + cost, sub[1] + extra)
            if result is None or candidate < result[:2]:
                result = (candidate[0], candidate[1], option, after)
        memo[rem] = result
        return result

    found = best(start)
    if found is None:
        return None
    chosen = []
    step = found
    while step[2] is not None:
        chosen.append(step[2])
        after = memo[step[3]]
        assert after is not None  # every step on the chain was a cover found
        step = after
    order = {o.id: i for i, o in enumerate(options)}
    return tuple(sorted(chosen, key=lambda o: order[o.id]))


class _Covers:
    """``_cheapest_cover`` per printer's usable plates, remembered across plans."""

    def __init__(self, inputs: PlanInputs, matched_ids: frozenset[int]):
        self._inputs = inputs
        self._matched_ids = matched_ids
        self._usable: dict[tuple[int, bool], tuple[tuple[PlateOption, ...], tuple[int, ...]]] = {}
        self._memo: dict[tuple, tuple[PlateOption, ...] | None] = {}
        self._alternatives: dict[tuple, list[tuple[PlateOption, ...]]] = {}

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

    def alternatives(
        self, printer: PlannerPrinter, needs: tuple[tuple[int, int], ...], *, matched: bool
    ) -> list[tuple[PlateOption, ...]]:
        """Sets of plates worth trying for ``needs`` (``_improve``): the cheapest, the fewest, one plate repeated."""
        usable, ids = self._usable_on(printer, matched)
        key = (ids, needs)
        if key not in self._alternatives:
            found = []
            cheapest = self.cover(printer, needs, matched=matched)
            if cheapest:
                found.append(cheapest)
            # A plate cost that drowns print time: the fewest plates.
            fewest = _cheapest_cover(usable, needs, 10**9)
            if fewest:
                found.append(fewest)
            for option in usable:
                if all(option.count(pid) for pid, n in needs if n):
                    repeats = max(math.ceil(n / option.count(pid)) for pid, n in needs if n)
                    found.append((option,) * repeats)
            unique: dict[tuple[int, ...], tuple[PlateOption, ...]] = {}
            for plates in found:
                unique.setdefault(tuple(sorted(o.id for o in plates)), plates)
            self._alternatives[key] = list(unique.values())
        return self._alternatives[key]


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


class _Spools:
    """One printer's spools as a plan goes on: its trays' known amounts, and spools loaded for its plates."""

    def __init__(self, left: Mapping[int, float], margin_pct: float, full_g: float):
        self.left = dict(left)
        # Filament (FilamentUse.key) loaded for a plate no tray held -> grams left.
        self.loaded: dict[str, float] = {}
        self._factor = 1 + max(0.0, margin_pct) / 100
        self._full = full_g

    def copy(self) -> _Spools:
        other = _Spools(self.left, 0.0, self._full)
        other._factor = self._factor
        other.loaded = dict(self.loaded)
        return other

    @staticmethod
    def _needs(uses: Sequence[FilamentUse]) -> tuple[dict[int, float], dict[str, float]]:
        """Grams per tray, and per filament no tray holds (two of a file's filaments may share one)."""
        trays: dict[int, float] = {}
        unheld: dict[str, float] = {}
        for use in uses:
            if use.tray is None:
                unheld[use.key] = unheld.get(use.key, 0.0) + use.grams
            else:
                trays[use.tray] = trays.get(use.tray, 0.0) + use.grams
        return trays, unheld

    def _swaps(self, uses: Sequence[FilamentUse]) -> tuple[dict[int, str], dict[str, str]]:
        trays, unheld = self._needs(uses)
        by_tray = {
            tray: SWAP_CHANGE
            for tray, grams in trays.items()
            if tray in self.left and self.left[tray] < grams * self._factor
        }
        by_key = {}
        for key, grams in unheld.items():
            have = self.loaded.get(key)
            if have is None:
                by_key[key] = SWAP_LOAD
            elif have < grams * self._factor:
                by_key[key] = SWAP_CHANGE
        return by_tray, by_key

    def swap_for(self, uses: Sequence[FilamentUse]) -> str | None:
        """SWAP_LOAD when no spool holds a filament, SWAP_CHANGE when one runs out first, else None."""
        by_tray, by_key = self._swaps(uses)
        kinds = set(by_tray.values()) | set(by_key.values())
        return SWAP_LOAD if SWAP_LOAD in kinds else SWAP_CHANGE if kinds else None

    def take(self, uses: Sequence[FilamentUse]) -> tuple[FilamentNote, ...]:
        """Print with ``uses``: a fresh spool first where one runs out or none is there."""
        by_tray, by_key = self._swaps(uses)
        trays, unheld = self._needs(uses)
        for tray, grams in trays.items():
            if tray in self.left:
                start = self._full if tray in by_tray else self.left[tray]
                self.left[tray] = max(0.0, start - grams)
        for key, grams in unheld.items():
            start = self._full if key in by_key else self.loaded[key]
            self.loaded[key] = max(0.0, start - grams)
        return tuple(
            FilamentNote(
                use.type,
                use.color,
                use.grams,
                use.tray,
                self.left.get(use.tray) if use.tray is not None else self.loaded.get(use.key),
                by_tray.get(use.tray) if use.tray is not None else by_key.get(use.key),
            )
            for use in uses
        )


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


def _have(inputs: PlanInputs) -> Pool:
    """The pieces there now or printing now."""
    have = _copy(inputs.stock)
    for arrival in inputs.arriving:
        pool_add(have, arrival.printer_id, arrival.pieces)
    return have


def _to_make(inputs: PlanInputs, have: Pool) -> dict[int, int]:
    """Part id -> pieces the orders still need printed (matched parts as whole sets)."""
    wanted = sum(o.units for o in inputs.orders)
    matched = [p for p in inputs.parts if p.matched]
    to_make: dict[int, int] = {}
    if matched:
        work = {m.id: {r: n for r, n in have.get(m.id, {}).items() if n > 0} for m in matched}
        missing_units = max(0, wanted - _matched_units(work, matched))
        to_make = {m.id: missing_units * m.per_unit for m in matched}
    for p in inputs.parts:
        if not p.matched:
            to_make[p.id] = max(0, wanted * p.per_unit - _total(have, p.id))
    return to_make


def _fresh_spools(inputs: PlanInputs, printer_id: int) -> _Spools:
    return _Spools(inputs.filament_left.get(printer_id, {}), inputs.filament_margin_pct, inputs.full_spool_g)


def _run(
    inputs: PlanInputs,
    printer_id: int,
    chosen: Sequence[PlateOption],
    at: datetime,
    state: _Spools,
    record: list | None,
) -> tuple[datetime, bool]:
    """Print ``chosen`` in this order from ``at``: when the printer is free again, and whether a spool was swapped.

    Each plate starts when the one before is cleared; a plate needing a spool
    loaded or changed waits for someone to be there and for the swap.
    ``record`` gets (option, start, end, ready, filament notes, swap) per plate.
    """
    swapped = False
    swap = timedelta(seconds=inputs.swap_s)
    for option in chosen:
        uses = inputs.filament_use.get(option.id, {}).get(printer_id, ())
        needs = state.swap_for(uses) if uses else None
        start = at
        if needs is not None:
            swapped = True
            start = (inputs.staffed_at(start) if inputs.staffed_at is not None else start) + swap
        end = start + timedelta(seconds=option.duration_s)
        ready = max(end, inputs.ready_after(end)) if inputs.ready_after is not None else end
        notes = state.take(uses) if uses else ()
        if record is not None:
            record.append((option, start, end, ready, notes, needs))
        at = ready
    return at, swapped


def _fixed_cost(
    inputs: PlanInputs, plates: Sequence[PlannedPlate], to_make: Mapping[int, int], piece_time: Mapping[int, float]
) -> tuple[float, dict[int, int]]:
    """The cost of a plan that does not depend on time (preferences aside), and its extra pieces.

    A cost per plate, pieces made beyond the orders, and the print time and
    plate cost a failing plate is expected to waste (``risk`` of them).
    """
    made: dict[int, int] = {}
    cost = 0.0
    for planned in plates:
        option = planned.option
        cost += inputs.plate_cost_s + option.risk * (option.duration_s + inputs.plate_cost_s)
        for part_id, n in option.pieces:
            made[part_id] = made.get(part_id, 0) + n
    extra = {part_id: n - to_make.get(part_id, 0) for part_id, n in made.items() if n - to_make.get(part_id, 0) > 0}
    cost += sum(EXTRA_PIECE_WEIGHT * n * piece_time.get(part_id, 0.0) for part_id, n in extra.items())
    return cost, extra


def _wait_cost(inputs: PlanInputs, plates: Sequence[PlannedPlate]) -> tuple[float, dict[int, datetime | None]]:
    """How long until each order can be picked up, lateness counted ``LATE_WEIGHT`` times."""
    now = inputs.now
    finish = {p.id: timedelta(seconds=p.finish_s) for p in inputs.parts}
    zero = timedelta(0)
    # What ``ready_times`` makes of the stock, the arrivals and the plates,
    # without an Arrival per plate: this runs for every candidate plan.
    events = [
        (now, printer_id, part_id, n)
        for part_id, by_printer in inputs.stock.items()
        for printer_id, n in by_printer.items()
        if n > 0
    ]
    for arrival in inputs.arriving:
        for part_id, n in arrival.pieces:
            events.append(
                (arrival.at + (zero if arrival.finished else finish.get(part_id, zero)), arrival.printer_id, part_id, n)
            )
    for planned in plates:
        for part_id, n in planned.option.pieces:
            events.append((planned.ready + finish.get(part_id, zero), planned.printer_id, part_id, n))
    ready_at = _ready_from_events(inputs.parts, inputs.orders, events, now)
    cost = 0.0
    for order in inputs.orders:
        ready = ready_at[order.id]
        finished = ready if ready is not None else now + NEVER
        cost += (finished - now).total_seconds()
        if order.due is not None and finished > order.due:
            cost += LATE_WEIGHT * (finished - order.due).total_seconds()
    return cost, ready_at


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

    have = _have(inputs)

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
    to_make = _to_make(inputs, have)

    free = {p.id: max(p.free_at, now) for p in inputs.printers}
    rank = {p.id: i for i, p in enumerate(inputs.printers)}
    plates: list[PlannedPlate] = []
    piece_time = _piece_times(inputs)

    finish_of = {p.id: p.finish_s for p in inputs.parts}

    def finishing(option: PlateOption) -> int:
        return max((finish_of.get(part_id, 0) for part_id, _ in option.pieces), default=0)

    def ordered(chosen: Sequence[PlateOption]) -> list[PlateOption]:
        # Pieces that still need work after printing (a base to glue a tray
        # into) go first; the rest prints while they dry.
        return sorted(chosen, key=lambda o: -finishing(o))

    spools = {p.id: _fresh_spools(inputs, p.id) for p in inputs.printers}

    def run(
        printer_id: int, chosen: Sequence[PlateOption], at: datetime, state: _Spools, record: list | None
    ) -> tuple[datetime, bool]:
        return _run(inputs, printer_id, chosen, at, state, record)

    def schedule(printer: PlannerPrinter, chosen: tuple[PlateOption, ...], pinned: bool) -> list[PlannedPlate]:
        record: list = []
        free[printer.id], _ = run(printer.id, ordered(chosen), free[printer.id], spools[printer.id], record)
        placed = []
        for option, start, end, ready, notes, needs in record:
            planned = PlannedPlate(option, printer.id, start, end, ready, pinned, filament=notes, swap=needs)
            plates.append(planned)
            placed.append(planned)
            for part_id, n in option.pieces:
                if part_id in missing:
                    missing[part_id] -= n
        return placed

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

    def finish(printer: PlannerPrinter, chosen: tuple[PlateOption, ...]) -> tuple[datetime, bool]:
        return run(printer.id, ordered(chosen), free[printer.id], spools[printer.id].copy(), None)

    prefs = list(inputs.preferences)
    matched_ids = frozenset(m.id for m in matched)
    pref_penalty = 0.0

    def margin_s(chosen: Sequence[PlateOption]) -> float:
        """How much sooner another printer must be done to beat the preferred one."""
        return max(inputs.prefer_min_s, inputs.prefer_pct / 100 * sum(o.duration_s for o in chosen))

    def settle(relevant: list[Preference], placed: list[PlannedPlate], best: tuple, candidates: dict) -> float:
        """Hand a placed package's preferences to its plates; returns the cost of those it overrules."""
        winner = best[0].id
        mine = [pr for pr in relevant if pr.printer_id == winner]
        others = [pr for pr in relevant if pr.printer_id != winner]
        penalty = 0.0
        for planned in placed:
            for pool in (mine, others):
                pr = next((p for p in pool if p.plate_id == planned.option.id), pool[0] if pool else None)
                if pr is not None:
                    pool.remove(pr)
                    prefs.remove(pr)
                    break
            if pr is None:
                continue
            planned.preferred = pr.printer_id
            if pr.printer_id == winner:
                continue
            rival = candidates.get(pr.printer_id)
            if rival is None:
                planned.overruled = OVERRULED_UNAVAILABLE
            elif rival[5] and not best[5]:
                planned.overruled = OVERRULED_FILAMENT
            else:
                planned.overruled = OVERRULED_EARLIER
                planned.overruled_by_s = max(0, int((rival[4] - best[4]).total_seconds()))
                penalty += margin_s((planned.option,))
        return penalty

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
            group_parts = matched_ids if kind == "matched" else frozenset((part_id,))
            relevant = [pr for pr in prefs if pr.parts & group_parts]
            preferred_ids = {pr.printer_id for pr in relevant}
            # printer id -> (printer, units, chosen, products, done at, spool swapped)
            candidates: dict[int, tuple] = {}
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
                done_at, swapped = finish(printer, chosen)
                candidates[printer.id] = (printer, units, chosen, products, done_at, swapped)
            if not candidates:
                continue
            # A preferred printer that needs a spool swapped for the package
            # loses its nudge to one that does not.
            clean = any(not c[5] for c in candidates.values())
            best_key = None
            best: tuple = ()
            for candidate in candidates.values():
                printer, _, chosen, products, done_at, swapped = candidate
                wait = (done_at - now).total_seconds()
                if printer.id in preferred_ids and not (swapped and clean):
                    wait -= margin_s(chosen)
                key = (wait / products, done_at, rank[printer.id])
                if best_key is None or key < best_key:
                    best_key, best = key, candidate
            printer, units, chosen = best[0], best[1], best[2]
            placed_plates = schedule(printer, chosen, kind == "matched")
            if kind == "matched":
                take_matched(printer, units, chosen)
            if relevant:
                pref_penalty += settle(relevant, placed_plates, best, candidates)
            placed = True
            break
        if not placed:
            break

    # Preferences no package took (its set's pieces already on a printer):
    # the plate printing their plate carries them on.
    for pr in list(prefs):
        planned = next((p for p in plates if p.preferred is None and p.option.id == pr.plate_id), None)
        if planned is None:
            continue
        prefs.remove(pr)
        planned.preferred = pr.printer_id
        if planned.printer_id != pr.printer_id:
            planned.overruled = OVERRULED_PIECES if planned.pinned else OVERRULED_UNAVAILABLE

    short = {m.id: missing_units * m.per_unit for m in matched if missing_units > 0}
    short |= {part_id: n for part_id, n in missing.items() if n > 0}
    fixed_cost, extra = _fixed_cost(inputs, plates, to_make, piece_time)
    fixed_cost += pref_penalty
    start_of = {p.id: max(p.free_at, now) for p in inputs.printers}

    def score(candidate: list[PlannedPlate]) -> tuple[float, dict[int, datetime | None]]:
        waits, ready_at = _wait_cost(inputs, candidate)
        return fixed_cost + waits, ready_at

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
            record: list = []
            run(printer_id, [p.option for p in order], start_of[printer_id], _fresh_spools(inputs, printer_id), record)
            for planned, (_, start, end, ready, notes, needs) in zip(order, record, strict=True):
                result.append(replace(planned, start=start, end=end, ready=ready, filament=notes, swap=needs))
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
    return Plan(
        plates=plates,
        ready_at=ready_at,
        cost=cost,
        short=short,
        extra=extra,
        caps=used_caps,
        packing=packing,
        preference_s=pref_penalty,
    )


Lanes = dict[int, list[PlannedPlate]]


def _improve(inputs: PlanInputs, start: Plan, covers: _Covers) -> Plan:
    """``start`` improved by local search, scored by the plan's own cost.

    The enumeration chooses plates by print time and never sees the clock: a
    printer free at night prints three short plates where one long one would
    run through the night, and a package's plates print in the order they are
    listed. Moves, each re-timed (``_run``) and re-scored in full, taken only
    when the plan gets cheaper, the first found first, until none does:

    - swap the cover: some of a printer's plates (consecutive ones of a kind:
      matched, or loose plates of the same parts) replaced by other plates
      that run on it and print at least the same pieces: the cheapest set,
      the fewest plates, or one plate repeated. Loose plates may also be
      replaced by plates for only what the orders still want of them (or
      dropped, when that is nothing): a swap that made a spare plate;
    - reorder: a plate moved to another place on its printer;
    - move: a plate not pinned (printing no matched part, and not one of a
      matched package's plates) moved to another printer it runs on, at its
      start, its end, or about the same time.

    Plates someone preferred a printer for are only reordered, so the plan's
    preference cost stays as it was. Matched pieces never drop on their
    printer and loose pieces never below what the orders need, so nothing
    becomes short. Bounded by ``IMPROVE_MAX_MOVES`` and ``IMPROVE_MAX_TRIES``.
    """
    if not start.plates:
        return start
    piece_time = _piece_times(inputs)
    to_make = _to_make(inputs, _have(inputs))
    matched_ids = frozenset(p.id for p in inputs.parts if p.matched)
    printers = {p.id: p for p in inputs.printers}
    start_of = {p.id: max(p.free_at, inputs.now) for p in inputs.printers}
    finish_of = {p.id: p.finish_s for p in inputs.parts}

    lanes: Lanes = {p.id: [] for p in inputs.printers}
    for planned in sorted(start.plates, key=lambda p: p.start):
        lanes[planned.printer_id].append(planned)

    def signature(lane: Sequence[PlannedPlate]) -> tuple:
        return tuple((p.option.id, p.pinned, p.preferred) for p in lane)

    def timed(printer_id: int, lane: list[PlannedPlate]) -> list[PlannedPlate]:
        record: list = []
        options = [p.option for p in lane]
        _run(inputs, printer_id, options, start_of[printer_id], _fresh_spools(inputs, printer_id), record)
        return [
            replace(p, printer_id=printer_id, start=st, end=en, ready=re, filament=notes, swap=needs)
            for p, (_, st, en, re, notes, needs) in zip(lane, record, strict=True)
        ]

    def flat(candidate: Lanes) -> list[PlannedPlate]:
        return [p for printer_id in printers for p in candidate[printer_id]]

    def evaluate(candidate: Lanes, bound: float) -> tuple[float, dict, dict] | None:
        """The candidate's cost, ready times and extra pieces; None when it costs ``bound`` or more."""
        plates = flat(candidate)
        fixed, extra = _fixed_cost(inputs, plates, to_make, piece_time)
        fixed += start.preference_s
        if fixed >= bound:
            return None
        waits, ready_at = _wait_cost(inputs, plates)
        return fixed + waits, ready_at, extra

    def alternatives(printer_id: int, matched: bool, needs: tuple[tuple[int, int], ...]) -> list:
        return covers.alternatives(printers[printer_id], needs, matched=matched)

    def finishing(option: PlateOption) -> int:
        return max((finish_of.get(part_id, 0) for part_id, _ in option.pieces), default=0)

    def swaps(current: Lanes, printer_id: int) -> Iterable[Lanes]:
        made: dict[int, int] = {}
        for planned in flat(current):
            for part_id, n in planned.option.pieces:
                made[part_id] = made.get(part_id, 0) + n
        lane = current[printer_id]
        groups: dict[object, list[int]] = {}
        for index, planned in enumerate(lane):
            if planned.preferred is None:
                kind = "matched" if planned.pinned else frozenset(pid for pid, n in planned.option.pieces if n)
                groups.setdefault(kind, []).append(index)
        seen = {signature(lane)}
        for kind, indexes in groups.items():
            matched = kind == "matched"
            for a in range(len(indexes)):
                for b in range(a + 1, len(indexes) + 1):
                    window = indexes[a:b]
                    counts: dict[int, int] = {}
                    for index in window:
                        for pid, n in lane[index].option.pieces:
                            if n:
                                counts[pid] = counts.get(pid, 0) + n
                    needs = tuple(sorted(counts.items()))
                    tried = list(alternatives(printer_id, matched, needs))
                    if not matched:
                        # Loose pieces beyond the orders need not be printed again:
                        # also cover only what is still wanted (nothing: drop them).
                        wanted = tuple((pid, max(0, n - max(0, made[pid] - to_make.get(pid, 0)))) for pid, n in needs)
                        if wanted != needs:
                            tried += alternatives(printer_id, matched, wanted) if any(n for _, n in wanted) else [()]
                    dropped = set(window)
                    kept = [p for index, p in enumerate(lane) if index not in dropped]
                    for cover in tried:
                        # Times are placeholders: every candidate is re-timed. The
                        # new plates go where the first old one was; reorder moves
                        # them on. They are pinned as the plates they replace, as
                        # the enumeration pins a matched package's every plate (a
                        # tray-only plate among them too): a plate on the same
                        # printer pinned one plan and not the next would never
                        # keep its waiting job (products.replan matches by both).
                        at = inputs.now
                        added = [
                            PlannedPlate(o, printer_id, at, at, at, matched)
                            for o in sorted(cover, key=lambda o: -finishing(o))
                        ]
                        new = kept[: window[0]] + added + kept[window[0] :]
                        if signature(new) not in seen:
                            seen.add(signature(new))
                            yield {printer_id: new}

    def reorders(current: Lanes, printer_id: int) -> Iterable[Lanes]:
        lane = current[printer_id]
        seen = {signature(lane)}
        for i, planned in enumerate(lane):
            rest = lane[:i] + lane[i + 1 :]
            for j in range(len(lane)):
                new = rest[:j] + [planned] + rest[j:]
                if signature(new) not in seen:
                    seen.add(signature(new))
                    yield {printer_id: new}

    def moves(current: Lanes, printer_id: int) -> Iterable[Lanes]:
        lane = current[printer_id]
        seen: set[tuple] = set()
        for i, planned in enumerate(lane):
            if planned.pinned or planned.preferred is not None:
                continue
            rest = lane[:i] + lane[i + 1 :]
            for other in inputs.printers:
                if other.id == printer_id or not planned.option.runs_on(other):
                    continue
                target = current[other.id]
                alongside = sum(1 for p in target if p.start < planned.start)
                for place in sorted({0, alongside, len(target)}):
                    new = target[:place] + [planned] + target[place:]
                    key = (signature(rest), other.id, signature(new))
                    if key not in seen:
                        seen.add(key)
                        yield {printer_id: rest, other.id: new}

    first = evaluate(lanes, math.inf)
    assert first is not None
    cost, ready_at, extra = first
    accepted = 0
    tries = 0
    # Passes over every kind of move and every printer's lane, each lane's
    # first cheaper candidate taken, until a pass finds none (or the bounds).
    progress = True
    while progress and accepted < IMPROVE_MAX_MOVES and tries < IMPROVE_MAX_TRIES:
        progress = False
        for kind in (swaps, reorders, moves):
            for printer_id in printers:
                for changed in kind(lanes, printer_id):
                    tries += 1
                    if tries > IMPROVE_MAX_TRIES:
                        break
                    candidate = {**lanes, **{pid: timed(pid, lane) for pid, lane in changed.items()}}
                    # Cheaper by more than rounding: no endless moves between equals.
                    scored = evaluate(candidate, cost - 1e-6)
                    if scored is not None and scored[0] < cost - 1e-6:
                        lanes, (cost, ready_at, extra) = candidate, scored
                        accepted += 1
                        progress = True
                        break
                if tries > IMPROVE_MAX_TRIES or accepted >= IMPROVE_MAX_MOVES:
                    break
            if tries > IMPROVE_MAX_TRIES or accepted >= IMPROVE_MAX_MOVES:
                break
    if not accepted:
        return start

    plates = flat(lanes)
    made: dict[int, int] = {}
    for planned in plates:
        for part_id, n in planned.option.pieces:
            made[part_id] = made.get(part_id, 0) + n
    # Matched pieces only stay on or join their printer: what was short stays
    # short. A loose part is short by what the plates leave missing.
    short = {pid: n for pid, n in start.short.items() if pid in matched_ids}
    short |= {
        p.id: to_make[p.id] - made.get(p.id, 0)
        for p in inputs.parts
        if not p.matched and to_make[p.id] - made.get(p.id, 0) > 0
    }
    return Plan(
        plates=plates,
        ready_at=ready_at,
        cost=cost,
        short=short,
        extra=extra,
        caps=start.caps,
        packing=start.packing,
        alternatives=start.alternatives,
        preference_s=start.preference_s,
    )


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
    # The cheapest few plans are improved: another may end up cheaper once improved.
    # Several caps often build the very same plan: each is improved once.
    distinct: dict[tuple, Plan] = {}
    for built in sorted(tried.values(), key=lambda p: (p.cost, len(p.plates))):
        key = tuple(sorted((p.printer_id, p.start, p.option.id) for p in built.plates))
        distinct.setdefault(key, built)
        if len(distinct) == IMPROVE_PLANS:
            break
    leaders = list(distinct.values())
    best = min((_improve(inputs, leader, covers) for leader in leaders), key=lambda p: (p.cost, len(p.plates)))
    best.alternatives = dict(alternatives)
    return best
