"""Colours and filament profiles that are the same though named differently (fork).

A file asks for a filament by type, colour and profile (``tray_info_idx``: the
slicer preset it was sliced with, "GFG99" for Bambu's Generic PETG, "P..." for
a user preset); an AMS slot reports the same three. With "force colour match"
the queue holds a job until a printer has every forced slot in exactly that
colour, and in that profile when both sides name one (the profile is how Bambu
tells PLA Basic from PLA Matte, #2650).

Some setups name one filament two ways: files for one printer model sliced on
Generic PETG and for another on a user preset of the same PETG, or a colour
re-picked in the slicer after half the files were sliced. Here someone says
which colours, and which profiles, are one and the same: the queue's matching
(services/print_scheduler.py) compares a colour or a profile by its group, so
a job forced to ``#DCDB4E`` takes a spool reported as ``#E2DF60`` when the two
are in one group. Nothing else changes: what the files and the printers report
stays as it is.

Stored as one settings row (JSON), read into this module when the app starts,
on every scheduler pass, and when the groups are saved: the queue compares
colours many times a pass, synchronously.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

SETTINGS_KEY = "filament_aliases"
MAX_GROUPS = 100
MAX_MEMBERS = 50
MAX_PRESET_LENGTH = 64

_HEX = re.compile(r"^[0-9a-f]{6}$")


@dataclass(frozen=True)
class Aliases:
    """Groups of colours (6-digit lowercase hex, no '#') and of profiles (``tray_info_idx``)."""

    colors: tuple[tuple[str, ...], ...] = ()
    presets: tuple[tuple[str, ...], ...] = ()

    def to_json(self) -> dict:
        return {"colors": [list(g) for g in self.colors], "presets": [list(g) for g in self.presets]}


# Member -> the group's first member. Empty: nothing is merged.
_colors: dict[str, str] = {}
_presets: dict[str, str] = {}
_current = Aliases()


def normalize_color(raw: str | None) -> str:
    """A colour as 6-digit lowercase hex without '#' (alpha dropped); '' when it is not one."""
    text = (raw or "").strip().lstrip("#").lower()[:6]
    return text if _HEX.match(text) else ""


def _groups(raw: Iterable, clean_member) -> tuple[tuple[str, ...], ...]:
    """Clean members, drop groups of fewer than two, and join groups sharing a member."""
    merged: list[list[str]] = []
    for group in list(raw or [])[:MAX_GROUPS]:
        members: list[str] = []
        for value in list(group or [])[:MAX_MEMBERS]:
            cleaned = clean_member(value)
            if cleaned and cleaned not in members:
                members.append(cleaned)
        if len(members) < 2:
            continue
        touching = [g for g in merged if any(m in g for m in members)]
        for g in touching:
            merged.remove(g)
        joined: list[str] = []
        for g in [*touching, members]:
            joined.extend(m for m in g if m not in joined)
        merged.append(joined)
    return tuple(tuple(g) for g in merged)


def _clean_preset(value) -> str:
    text = str(value or "").strip()
    return text if 0 < len(text) <= MAX_PRESET_LENGTH else ""


def clean(raw: dict | None) -> Aliases:
    """Groups as given (a dict with ``colors`` and ``presets`` lists of lists), cleaned."""
    raw = raw if isinstance(raw, dict) else {}
    return Aliases(
        colors=_groups(raw.get("colors"), normalize_color),
        presets=_groups(raw.get("presets"), _clean_preset),
    )


def apply(aliases: Aliases) -> None:
    """Make ``aliases`` the groups the matching goes by."""
    global _current
    _colors.clear()
    _presets.clear()
    for group in aliases.colors:
        for member in group:
            _colors[member] = group[0]
    for group in aliases.presets:
        for member in group:
            _presets[member] = group[0]
    _current = aliases


def current() -> Aliases:
    return _current


def color(normalized: str) -> str:
    """The colour a normalized colour stands for: its group's first member, or itself."""
    return _colors.get(normalized, normalized) if _colors else normalized


def preset(value: str | None) -> str:
    """The profile a ``tray_info_idx`` stands for: its group's first member, or itself ('' for none)."""
    text = (value or "").strip() if isinstance(value, str) else ""
    return _presets.get(text, text) if _presets else text


def with_presets(rows: list[dict]) -> list[dict]:
    """``rows`` with each ``tray_info_idx`` read as its group's profile (copies only where it changes)."""
    if not _presets:
        return rows
    result = []
    for row in rows:
        idx = row.get("tray_info_idx")
        stands_for = preset(idx) if isinstance(idx, str) else idx
        result.append(dict(row, tray_info_idx=stands_for) if stands_for != idx else row)
    return result


async def read(db: AsyncSession) -> Aliases:
    from backend.app.models.settings import Settings

    raw = (await db.execute(select(Settings.value).where(Settings.key == SETTINGS_KEY))).scalar()
    if not raw:
        return Aliases()
    try:
        return clean(json.loads(raw))
    except (TypeError, ValueError):
        logger.warning("Filament aliases: the stored groups are not JSON, none are used")
        return Aliases()


async def refresh(db: AsyncSession) -> Aliases:
    """Read the stored groups and use them. Never raises: the matching goes on with what it had."""
    try:
        aliases = await read(db)
    except Exception as e:
        logger.warning("Filament aliases: could not read the groups: %s", e)
        return _current
    if aliases != _current:
        apply(aliases)
    return aliases


async def write(db: AsyncSession, aliases: Aliases) -> None:
    """Store the groups and use them. The caller commits."""
    from backend.app.core.db_dialect import upsert_setting
    from backend.app.models.settings import Settings

    await upsert_setting(db, Settings, SETTINGS_KEY, json.dumps(aliases.to_json()))
    apply(aliases)


async def load_at_startup() -> None:
    """Read the groups once the database is ready. Never raises."""
    try:
        from backend.app.core.database import async_session

        async with async_session() as db:
            await refresh(db)
    except Exception:
        logger.exception("Filament aliases: could not read the groups at startup")
