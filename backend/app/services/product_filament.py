"""The filament a product's plates take on each printer, and what the queue leaves on the spools (fork).

Feeds the planner (services/product_planner.py: ``PlanInputs.filament_use``
and ``filament_left``) from what the scheduler itself goes by, so the plan and
the dispatch agree:

* a printer's spools are its status (AMS trays and the external spool: type,
  colour, filament id), matched to a file's filaments with the scheduler's own
  matcher. With ``force`` (the planner's jobs ask for their files' colours)
  only the same type in the same colour counts, as the scheduler then holds a
  job for nothing less;
* how much is left on a tray is the inventory's (slot spools, Spoolman), as
  the filament check reads it. A tray without a known amount is not counted,
  and none is with the filament warnings switched off;
* the queue's work takes its share first: the print running now in full (its
  usage is charged when it ends) and every job forecast onto the printer
  before the product's own, each with the trays the scheduler would give it.

A printer whose status is not known (not connected since the start) is left
out: the planner checks nothing there.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import product_planner as planner

logger = logging.getLogger(__name__)

# Files read for their filaments, while each stays the same.
_REQUIREMENTS_CACHE_SIZE = 512
_requirements: dict[tuple[str, int | None, float], list[dict]] = {}


@dataclass
class PrinterSpools:
    """A printer's spools as the scheduler reads them, and the known amounts on them."""

    # scheduler._build_loaded_filaments: type, colour, tray_info_idx, global_tray_id, ...
    loaded: list[dict]
    # A Filament Track Switch feeds any slot to either nozzle.
    fts: bool = False
    # Global tray id -> grams left, where the inventory knows it.
    left: dict[int, float] = field(default_factory=dict)


@contextmanager
def _quiet(target: logging.Logger) -> Iterator[None]:
    """The matcher logs every pick: a plan weighs many that dispatch nothing.

    Safe in the event loop: the matcher is synchronous, so nothing else runs
    while its logger is off.
    """
    before = target.disabled
    target.disabled = True
    try:
        yield
    finally:
        target.disabled = before


def requirements(path: Path | None, plate_id: int | None) -> list[dict]:
    """A file's (plate's) filaments with their grams, as fresh dicts; [] when it cannot be read."""
    if path is None:
        return []
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    key = (str(path), plate_id, mtime)
    if key not in _requirements:
        from backend.app.services.filament_requirements import extract_filament_requirements

        if len(_requirements) >= _REQUIREMENTS_CACHE_SIZE:
            _requirements.clear()
        _requirements[key] = extract_filament_requirements(path, plate_id)
    return [dict(r) for r in _requirements[key]]


def _color(raw) -> str:
    text = str(raw or "").strip().lstrip("#")[:6].lower()
    return f"#{text}" if text else ""


def _usable(reqs: list[dict]) -> list[dict]:
    return [
        r
        for r in reqs
        if isinstance(r.get("slot_id"), int)
        and r["slot_id"] > 0
        and isinstance(r.get("used_grams"), (int, float))
        and r["used_grams"] > 0
    ]


def _uses(reqs: list[dict], mapping: list[int] | None) -> tuple[planner.FilamentUse, ...]:
    uses = []
    for r in reqs:
        index = r["slot_id"] - 1
        tray = mapping[index] if mapping is not None and index < len(mapping) else -1
        uses.append(
            planner.FilamentUse(
                type=str(r.get("type") or "?"),
                color=_color(r.get("color")),
                grams=float(r["used_grams"]),
                tray=tray if isinstance(tray, int) and tray >= 0 else None,
            )
        )
    return tuple(uses)


def match(reqs: list[dict], spools: PrinterSpools, *, force: bool) -> tuple[planner.FilamentUse, ...]:
    """The trays a file's filaments take on a printer (None where no tray will do)."""
    from backend.app.services import print_scheduler

    wanted = [dict(r, force_color_match=True) if force else r for r in _usable(reqs)]
    if not wanted:
        return ()
    mapping = None
    if spools.loaded:
        with _quiet(print_scheduler.logger):
            mapping = print_scheduler.scheduler._match_filaments_to_slots(
                wanted, spools.loaded, fts_installed=spools.fts
            )
    return _uses(wanted, mapping)


def item_uses(item: PrintQueueItem, printer_id: int, spools: PrinterSpools) -> tuple[planner.FilamentUse, ...]:
    """What a queue job takes from a printer's trays: the mapping it was given there, else the matcher's.

    ``item`` needs its archive and library file loaded.
    """
    from backend.app.services import print_scheduler
    from backend.app.services.filament_deficit import _parse_ams_mapping, _resolve_source_3mf

    reqs = _usable(requirements(_resolve_source_3mf(item), item.plate_id))
    if not reqs:
        return ()
    print_scheduler.scheduler._apply_filament_overrides(item, reqs)
    stored = _parse_ams_mapping(item.ams_mapping) if item.printer_id == printer_id else None
    if stored:
        return _uses(reqs, stored)
    return match(reqs, spools, force=False)


def take(left: dict[int, float], uses: Iterable[planner.FilamentUse]) -> None:
    """Take what ``uses`` print from the known amounts."""
    for use in uses:
        if use.tray is not None and use.tray in left:
            left[use.tray] = max(0.0, left[use.tray] - use.grams)


async def load_spools(db: AsyncSession, printer_ids: Iterable[int]) -> dict[int, PrinterSpools]:
    """Each printer's spools, for the printers whose status is known."""
    from backend.app.services import print_scheduler
    from backend.app.services.filament_deficit import _warnings_disabled, build_slot_materials
    from backend.app.services.printer_manager import printer_manager

    amounts = not await _warnings_disabled(db)
    result: dict[int, PrinterSpools] = {}
    for printer_id in printer_ids:
        status = printer_manager.get_status(printer_id)
        if status is None or not getattr(status, "raw_data", None):
            continue
        try:
            loaded = print_scheduler.scheduler._build_loaded_filaments(status)
        except Exception as e:  # a status the scheduler cannot read: nothing known
            logger.debug("[PRODUCTS] Could not read the spools of printer %s: %s", printer_id, e)
            continue
        left: dict[int, float] = {}
        if amounts:
            try:
                for slot in await build_slot_materials(db, printer_id):
                    left[slot.global_tray_id] = slot.remaining_grams
            except Exception as e:  # amounts are a nicety; types and colours still count
                logger.debug("[PRODUCTS] Could not read what is left on printer %s's spools: %s", printer_id, e)
        fts = bool(getattr(getattr(status, "fila_switch", None), "installed", False))
        result[printer_id] = PrinterSpools(loaded=loaded, fts=fts, left=left)
    return result


def force_color_overrides(reqs: list[dict]) -> str | None:
    """A plate's filaments as "force colour match" overrides (PrintQueueItem.filament_overrides), or None."""
    overrides = [
        {
            "slot_id": r["slot_id"],
            "type": str(r.get("type") or ""),
            "color": _color(r.get("color")),
            "tray_info_idx": str(r.get("tray_info_idx") or ""),
            "force_color_match": True,
        }
        for r in _usable(reqs)
        if r.get("type") and _color(r.get("color"))
    ]
    return json.dumps(overrides) if overrides else None


def plan_info(planned: planner.PlannedPlate) -> dict:
    """What the plan worked out for a job (ProductJob.plan_info)."""
    return {
        "filament": [
            {
                "type": note.type,
                "color": note.color,
                "grams": round(note.grams, 1),
                "tray": note.tray,
                "left": round(note.left, 1) if note.left is not None else None,
                "swap": note.swap,
            }
            for note in planned.filament
        ],
        "swap": planned.swap,
        "overruled": planned.overruled,
        "overruled_by_s": planned.overruled_by_s,
    }
