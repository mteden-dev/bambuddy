"""Every queued job asks for its file's colours (fork).

A green tray added by hand for "any P1S" went out on a P1S that had only FDE
loaded: nobody ticked "Force colour match", so the queue matched the type alone,
picked the first idle P1S and gave the green slot an FDE spool. The product
planner asks for its files' colours (product_filament.force_color_overrides);
a job added by hand did not.

With ``require_file_colors`` on, the scheduler writes the file's colours into
every pending job as "force colour match" overrides before it looks at a
printer (print_scheduler._force_file_colors). From there the job is one the
queue already knows how to handle: it goes only to a printer that has those
colours (filament_aliases count), it waits with "Needs PETG #408002" where none
has, and "Print Anyway" cannot send it out in another colour.

* A slot someone changed by hand keeps the colour they picked, which is then
  the one the job asks for.
* No filament profile is asked for: the files for one printer model can carry
  another profile than the spool in the AMS for the very same filament, and the
  setting is about the colour.
* A job whose file cannot be read is left as it is.
"""

from __future__ import annotations

import json

SETTING_KEY = "require_file_colors"


def _printed(requirements: list[dict]) -> dict[int, dict]:
    """The file's printed slots that name a type and a colour, by slot id."""
    slots: dict[int, dict] = {}
    for req in requirements:
        slot = req.get("slot_id") if isinstance(req, dict) else None
        if not isinstance(slot, int) or isinstance(slot, bool) or slot <= 0:
            continue
        if str(req.get("type") or "").strip() and str(req.get("color") or "").strip():
            slots.setdefault(slot, req)
    return slots


def forced_overrides(raw: str | None, requirements: list[dict] | None) -> str | None:
    """``raw`` (PrintQueueItem.filament_overrides) with every printed slot forced.

    Returns the new JSON, or None when there is nothing to change: every printed
    slot is forced already, the file could not be read, or ``raw`` is not a list
    of overrides.
    """
    if not requirements:
        return None
    try:
        overrides = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return None
    if not isinstance(overrides, list):
        return None

    printed = _printed(requirements)
    out: list = []
    covered: set[int] = set()
    changed = False
    for entry in overrides:
        if isinstance(entry, dict) and entry.get("slot_id") in printed:
            covered.add(entry["slot_id"])
            # A slot changed by hand: the colour picked is the one asked for.
            if (
                not entry.get("force_color_match")
                and str(entry.get("type") or "").strip()
                and str(entry.get("color") or "").strip()
            ):
                entry = {**entry, "force_color_match": True}
                changed = True
        out.append(entry)

    for slot in sorted(set(printed) - covered):
        req = printed[slot]
        out.append(
            {
                "slot_id": slot,
                "type": str(req["type"]).strip(),
                "color": str(req["color"]).strip(),
                "force_color_match": True,
            }
        )
        changed = True
    return json.dumps(out) if changed else None
