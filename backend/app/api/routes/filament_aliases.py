"""Colours and filament profiles that are the same (fork): read and save the groups.

What the groups do is in services/filament_aliases.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.schemas.not_null import IgnoresNullForRequiredColumns
from backend.app.services import filament_aliases as service

router = APIRouter(prefix="/filament-aliases", tags=["filament-aliases"])


class AliasesIn(IgnoresNullForRequiredColumns):
    # Stored in one settings row, so no column says a field can't be null.
    __orm_table__ = "settings"

    # Each group: colours ("#RRGGBB" or "RRGGBB") or profiles (tray_info_idx) that are one.
    colors: list[list[str]] = Field(default_factory=list, max_length=service.MAX_GROUPS)
    presets: list[list[str]] = Field(default_factory=list, max_length=service.MAX_GROUPS)


class SeenColor(BaseModel):
    # 6-digit lowercase hex, no '#'.
    color: str
    # Filament types it was seen as ("PETG").
    types: list[str]
    # Printer names whose slots hold it, and "queue" when a waiting job asks for it.
    where: list[str]


class SeenPreset(BaseModel):
    preset: str
    types: list[str]
    # What the printers and the inventory call it ("PETG HF", a preset's name).
    names: list[str]
    where: list[str]


class AliasesOut(BaseModel):
    colors: list[list[str]]
    presets: list[list[str]]
    seen_colors: list[SeenColor]
    seen_presets: list[SeenPreset]


def _add(bucket: dict, key: str, *, kind: str | None, where: str, name: str | None = None) -> None:
    entry = bucket.setdefault(key, {"types": [], "where": [], "names": []})
    if kind and kind not in entry["types"]:
        entry["types"].append(kind)
    if where not in entry["where"]:
        entry["where"].append(where)
    if name and name not in entry["names"]:
        entry["names"].append(name)


async def _seen(db: AsyncSession) -> tuple[list[SeenColor], list[SeenPreset]]:
    """The colours and profiles the printers' slots hold and the waiting jobs ask for."""
    import json

    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.models.printer import Printer
    from backend.app.models.spool import Spool
    from backend.app.services.printer_manager import printer_manager
    from backend.app.utils.filament_ids import normalize_slicer_filament

    colors: dict[str, dict] = {}
    presets: dict[str, dict] = {}
    printers = (await db.execute(select(Printer).where(Printer.is_active.is_(True)).order_by(Printer.id))).scalars()
    for printer in printers:
        status = printer_manager.get_status(printer.id)
        raw = getattr(status, "raw_data", None) or {}
        trays = [t for unit in raw.get("ams") or [] for t in unit.get("tray") or []]
        trays += list(raw.get("vt_tray") or [])
        for tray in trays:
            kind = (tray.get("tray_type") or "").strip().upper()
            if not kind:
                continue
            color = service.normalize_color(tray.get("tray_color"))
            if color:
                _add(colors, color, kind=kind, where=printer.name)
            idx = (tray.get("tray_info_idx") or "").strip()
            if idx:
                _add(presets, idx, kind=kind, where=printer.name, name=(tray.get("tray_sub_brands") or "").strip())

    pending = (
        await db.execute(select(PrintQueueItem.filament_overrides).where(PrintQueueItem.status == "pending"))
    ).scalars()
    for raw_overrides in pending:
        try:
            overrides = json.loads(raw_overrides) if isinstance(raw_overrides, str) else raw_overrides
        except ValueError:
            continue
        for o in overrides or []:
            if not isinstance(o, dict):
                continue
            kind = (o.get("type") or "").strip().upper() or None
            color = service.normalize_color(o.get("color"))
            if color:
                _add(colors, color, kind=kind, where="queue")
            idx = (o.get("tray_info_idx") or "").strip()
            if idx:
                _add(presets, idx, kind=kind, where="queue")

    if presets:
        rows = (
            await db.execute(
                select(Spool.slicer_filament, Spool.slicer_filament_name).where(
                    Spool.slicer_filament.is_not(None), Spool.slicer_filament_name.is_not(None)
                )
            )
        ).all()
        for slicer_filament, name in rows:
            idx = normalize_slicer_filament(slicer_filament)[0]
            for key in {slicer_filament, idx}:
                if key in presets and name and name.strip() not in presets[key]["names"]:
                    presets[key]["names"].append(name.strip())

    return (
        [SeenColor(color=c, types=v["types"], where=v["where"]) for c, v in sorted(colors.items())],
        [
            SeenPreset(preset=p, types=v["types"], names=v["names"], where=v["where"])
            for p, v in sorted(presets.items(), key=lambda kv: kv[0].lower())
        ],
    )


async def _out(db: AsyncSession, aliases: service.Aliases) -> AliasesOut:
    seen_colors, seen_presets = await _seen(db)
    return AliasesOut(
        colors=[list(g) for g in aliases.colors],
        presets=[list(g) for g in aliases.presets],
        seen_colors=seen_colors,
        seen_presets=seen_presets,
    )


@router.get("", response_model=AliasesOut)
@router.get("/", response_model=AliasesOut)
async def get_aliases(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    return await _out(db, await service.read(db))


@router.put("", response_model=AliasesOut)
@router.put("/", response_model=AliasesOut)
async def put_aliases(
    data: AliasesIn,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Replace the groups; a colour or profile in two groups joins them."""
    aliases = service.clean(data.model_dump())
    await service.write(db, aliases)
    await db.commit()
    return await _out(db, aliases)
