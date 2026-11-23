"""Slot spools (fork): count the filament in an AMS slot without naming the roll.

A roll without an RFID tag tells the printer nothing about itself, and this
install does not want to label rolls with QR codes or serial numbers either.
So the roll is not identified at all: the *slot* is. When a roll goes into a
slot, the user says it is a full one (1 kg) or how much is on it, and a spool
row is made for it with ``data_origin = "slot_quick"`` and assigned to the slot.
From there on everything is the built-in inventory as it is: the usage tracker
charges the slot's spool for every print (3MF grams, partial prints by layer),
and the filament check holds a job the slot cannot finish.

What this module adds around that:

* **Check settings.** ``filament_check_per_slot`` checks every slot against its
  own spool, never pooling the other spools AMS Filament Backup could switch
  to: the switch leaves a mark on the print. The printer's backup itself is
  untouched, as a last resort. ``filament_check_margin_pct`` asks for that much
  more than the 3MF says, since the slicer's estimate and the label's kilogram
  are both approximate and the error grows print by print. Without a stored
  value both behave as upstream does (pooling, no margin), which keeps
  upstream's own tests meaningful; ``seed_settings`` stores the fork's values
  (on, 5 %) once, at startup, on an install that has none yet.
* **Archive on unlink.** When a slot spool's assignment goes (the slot stayed
  empty for the unlink grace, the slot was reconfigured to another filament, or
  the user unassigned it), the spool is archived with what is left on it, so the
  inventory does not fill up with rolls that are no longer in any slot. Loading
  a roll again can bring one back ("restore") with its remaining grams.
* **Reload prompts.** A slot that goes empty and fills again before the unlink
  grace runs out keeps its spool: the printer cannot tell the same roll put back
  from another one. Such a slot gets a prompt (``custom_slot_reload_prompts``)
  until the user says "same roll" or loads a new one. A runout refilled during a
  print is the same case: the spool stays assigned while printing, so without
  the prompt a fresh roll would go on counting from the empty one.

A slot with a roll in it and no spool at all is "new"; that needs no state of
its own and is worked out by the client from the slot and its assignment.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete, event, exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.slot_spool_prompt import SlotSpoolPrompt
from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.models.spool_k_profile import SpoolKProfile
from backend.app.services.ams_slot_presence import spool_present

logger = logging.getLogger(__name__)

SLOT_SPOOL_ORIGIN = "slot_quick"
FULL_SPOOL_GRAMS = 1000
MAX_MARGIN_PCT = 100.0
# Stored by seed_settings on an install that has no value yet.
SEEDED_SETTINGS = {"filament_check_per_slot": "true", "filament_check_margin_pct": "5"}
# An archived roll with less than this on it is used up, not worth restoring.
RESTORABLE_MIN_GRAMS = 5.0


# ---------------------------------------------------------------- check settings


@dataclass(frozen=True)
class CheckSettings:
    """How the filament check weighs a print against the slots (fork settings).

    The defaults are upstream's behaviour: what a store without the settings gets.
    """

    per_slot: bool = False
    margin_pct: float = 0.0

    def with_margin(self, grams: float) -> float:
        return grams * (1 + self.margin_pct / 100)


def parse_margin_pct(raw: str | None) -> float:
    """The stored margin as a percentage in [0, 100]; none when unset or unreadable."""
    if raw is None:
        return 0.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if value != value:  # NaN
        return 0.0
    return min(max(value, 0.0), MAX_MARGIN_PCT)


async def load_check_settings(db: AsyncSession) -> CheckSettings:
    """Read both settings; an unreadable store checks as upstream does."""
    try:
        from backend.app.api.routes.settings import get_setting

        per_slot_raw = await get_setting(db, "filament_check_per_slot")
        margin_raw = await get_setting(db, "filament_check_margin_pct")
    except Exception as exc:  # noqa: BLE001 - a settings probe must not break the dispatch path
        logger.debug("Could not read filament check settings, using defaults: %s", exc)
        return CheckSettings()
    per_slot = (per_slot_raw or "").strip().lower() == "true"
    return CheckSettings(per_slot=per_slot, margin_pct=parse_margin_pct(margin_raw))


async def seed_settings() -> None:
    """Store the fork's check settings where the install has none yet (startup). Never raises."""
    try:
        from backend.app.core.database import async_session
        from backend.app.models.settings import Settings

        async with async_session() as db:
            present = set(
                (await db.execute(select(Settings.key).where(Settings.key.in_(list(SEEDED_SETTINGS))))).scalars()
            )
            missing = {k: v for k, v in SEEDED_SETTINGS.items() if k not in present}
            if not missing:
                return
            for key, value in missing.items():
                db.add(Settings(key=key, value=value))
            await db.commit()
            logger.info("Slot spools: stored default filament check settings %s", missing)
    except Exception:
        logger.exception("Could not store the default filament check settings")


# ------------------------------------------------------------ archive on unlink


def _archive_unassigned_slot_spool(_mapper, connection, target: SpoolAssignment) -> None:
    """After an assignment row is deleted: archive its slot spool if no slot holds it now.

    Runs inside the flush, on the flush's own connection, like the SQLite rule
    hooks in core/sqlite_fk. Only ``slot_quick`` spools: a spool the user made in
    the inventory keeps living there when it leaves a slot, as it always has.
    The slot's reload prompt goes too, it asked about this spool.
    """
    spool_id = target.spool_id
    if spool_id is None:
        return
    spool_t = Spool.__table__
    assignment_t = SpoolAssignment.__table__
    connection.execute(
        update(spool_t)
        .where(
            spool_t.c.id == spool_id,
            spool_t.c.data_origin == SLOT_SPOOL_ORIGIN,
            spool_t.c.archived_at.is_(None),
            ~exists().where(assignment_t.c.spool_id == spool_id),
        )
        .values(archived_at=datetime.now(timezone.utc))
    )
    prompt_t = SlotSpoolPrompt.__table__
    connection.execute(
        delete(prompt_t).where(
            prompt_t.c.printer_id == target.printer_id,
            prompt_t.c.ams_id == target.ams_id,
            prompt_t.c.tray_id == target.tray_id,
        )
    )


def install_hooks() -> None:
    """Register the archive hook once (idempotent: imported from several places)."""
    if not event.contains(SpoolAssignment, "after_delete", _archive_unassigned_slot_spool):
        event.listen(SpoolAssignment, "after_delete", _archive_unassigned_slot_spool)


install_hooks()


# -------------------------------------------------------------- reload prompts

# (printer_id, ams_id, tray_id) -> last presence the firmware reported.
_presence: dict[tuple[int, int, int], bool] = {}


def refilled_slots(printer_id: int, ams_data: list | None) -> list[tuple[int, int]]:
    """Slots that read empty on the previous AMS report and occupied on this one.

    Only the firmware's presence bit counts (services/ams_slot_presence); a tray
    without one (the external spool, a payload without ``tray_exist_bits``) is
    left out rather than guessed at. Two or more slots of one unit going empty in
    the same report is not a person: rolls come out one at a time, and an idle
    X1C on X1Plus firmware has been seen blanking a whole unit for one push
    (#3186). Such a report is skipped for that unit and its last reading kept.
    """
    refilled: list[tuple[int, int]] = []
    for unit in ams_data or []:
        if not isinstance(unit, dict):
            continue
        try:
            ams_id = int(unit.get("id"))
        except (TypeError, ValueError):
            continue
        readings: dict[int, bool] = {}
        for tray in unit.get("tray") or []:
            if not isinstance(tray, dict):
                continue
            try:
                tray_id = int(tray.get("id"))
            except (TypeError, ValueError):
                continue
            present = spool_present(tray)
            if present is not None:
                readings[tray_id] = present
        drops = [t for t, p in readings.items() if not p and _presence.get((printer_id, ams_id, t)) is True]
        if len(drops) >= 2:
            continue
        for tray_id, present in readings.items():
            key = (printer_id, ams_id, tray_id)
            before = _presence.get(key)
            _presence[key] = present
            if before is False and present:
                refilled.append((ams_id, tray_id))
    return refilled


def forget_printer(printer_id: int) -> None:
    for key in [k for k in _presence if k[0] == printer_id]:
        del _presence[key]


def reset() -> None:
    """Drop every reading (tests)."""
    _presence.clear()


async def _slot_spool_assignment(
    db: AsyncSession, printer_id: int, ams_id: int, tray_id: int
) -> SpoolAssignment | None:
    result = await db.execute(
        select(SpoolAssignment)
        .join(Spool, Spool.id == SpoolAssignment.spool_id)
        .where(
            SpoolAssignment.printer_id == printer_id,
            SpoolAssignment.ams_id == ams_id,
            SpoolAssignment.tray_id == tray_id,
            Spool.data_origin == SLOT_SPOOL_ORIGIN,
        )
    )
    return result.scalar_one_or_none()


async def record_refills(db: AsyncSession, printer_id: int, slots: list[tuple[int, int]]) -> int:
    """Write a prompt for each refilled slot that still holds a slot spool; returns how many."""
    written = 0
    for ams_id, tray_id in slots:
        assignment = await _slot_spool_assignment(db, printer_id, ams_id, tray_id)
        if assignment is None:
            continue
        await db.execute(
            delete(SlotSpoolPrompt).where(
                SlotSpoolPrompt.printer_id == printer_id,
                SlotSpoolPrompt.ams_id == ams_id,
                SlotSpoolPrompt.tray_id == tray_id,
            )
        )
        db.add(SlotSpoolPrompt(printer_id=printer_id, ams_id=ams_id, tray_id=tray_id, spool_id=assignment.spool_id))
        written += 1
        logger.info(
            "Slot spool %d on printer %d AMS%d-T%d: slot emptied and refilled, asking whether it is the same roll",
            assignment.spool_id,
            printer_id,
            ams_id,
            tray_id,
        )
    return written


async def observe_ams(printer_id: int, ams_data: list | None) -> None:
    """AMS change hook: prompt for slots refilled under a slot spool. Never raises."""
    try:
        slots = refilled_slots(printer_id, ams_data)
        if not slots:
            return
        from backend.app.core.database import async_session
        from backend.app.services.inventory_mode import spoolman_owns_assignments

        async with async_session() as db:
            if await spoolman_owns_assignments(db):
                return
            written = await record_refills(db, printer_id, slots)
            if not written:
                return
            await db.commit()
        from backend.app.core.websocket import ws_manager

        await ws_manager.broadcast({"type": "slot_spool_prompts_changed", "printer_id": printer_id})
    except Exception:
        logger.exception("Slot spool refill check failed for printer %s", printer_id)


async def list_prompts(db: AsyncSession) -> list[SlotSpoolPrompt]:
    """Open prompts whose slot still holds the spool they ask about."""
    assignment_t = SpoolAssignment.__table__
    result = await db.execute(
        select(SlotSpoolPrompt)
        .where(
            exists().where(
                assignment_t.c.printer_id == SlotSpoolPrompt.printer_id,
                assignment_t.c.ams_id == SlotSpoolPrompt.ams_id,
                assignment_t.c.tray_id == SlotSpoolPrompt.tray_id,
                assignment_t.c.spool_id == SlotSpoolPrompt.spool_id,
            )
        )
        .order_by(SlotSpoolPrompt.printer_id, SlotSpoolPrompt.ams_id, SlotSpoolPrompt.tray_id)
    )
    return list(result.scalars().all())


async def clear_prompt(db: AsyncSession, printer_id: int, ams_id: int, tray_id: int) -> bool:
    """Drop the slot's prompt ("same roll"); False when there was none."""
    result = await db.execute(
        delete(SlotSpoolPrompt).where(
            SlotSpoolPrompt.printer_id == printer_id,
            SlotSpoolPrompt.ams_id == ams_id,
            SlotSpoolPrompt.tray_id == tray_id,
        )
    )
    return bool(result.rowcount)


# --------------------------------------------------------------- load a roll


class SlotSpoolError(Exception):
    """A request the caller has to fix (unknown or unsuitable spool)."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class KProfileChoice:
    """The calibration profile the slot was set to, kept on the spool for later replays."""

    cali_idx: int
    k_value: float
    extruder: int = 0
    nozzle_diameter: str = "0.4"
    name: str | None = None
    setting_id: str | None = None


@dataclass(frozen=True)
class SlotSpoolLoad:
    """A roll going into a slot, as configured on the printer a moment ago."""

    printer_id: int
    ams_id: int
    tray_id: int
    # The slot's tray_type and tray_color (RRGGBBAA) as just sent to the printer.
    # They are also the assignment's fingerprint: the unlink pass compares the
    # slot against them on every AMS report, and against the spool's own
    # material and colour on a mismatch.
    material: str
    rgba: str | None = None
    color_name: str | None = None
    slicer_filament: str | None = None
    slicer_filament_name: str | None = None
    # Grams on the roll. None with ``restore_spool_id`` keeps what the restored
    # spool had; None for a new roll means a full one.
    remaining_grams: float | None = None
    restore_spool_id: int | None = None
    k_profile: KProfileChoice | None = None
    assigned_by_user_id: int | None = None


def _clean(value: str | None, limit: int) -> str | None:
    text = (value or "").strip()
    return text[:limit] or None


def _normalize_rgba(value: str | None) -> str | None:
    text = (value or "").strip().lstrip("#").upper()
    if len(text) == 6:
        text += "FF"
    if len(text) != 8 or any(c not in "0123456789ABCDEF" for c in text):
        return None
    return text


async def load_slot_spool(db: AsyncSession, data: SlotSpoolLoad) -> SpoolAssignment:
    """Give the slot a slot spool: a new roll, or an archived one restored.

    Replaces whatever the slot held (its slot spool, if it had one, is archived
    by the hook). The caller holds the printer's assignment lock and commits.
    """
    if data.remaining_grams is not None and data.remaining_grams < 0:
        raise SlotSpoolError(422, "remaining_grams must not be negative")
    material = _clean(data.material, 50)
    if not material:
        raise SlotSpoolError(422, "material is required")
    rgba = _normalize_rgba(data.rgba)

    # Out with the slot's current spool first: the hook archives a slot spool
    # that this leaves in no slot, which is what restoring below may undo.
    old = await db.execute(
        select(SpoolAssignment).where(
            SpoolAssignment.printer_id == data.printer_id,
            SpoolAssignment.ams_id == data.ams_id,
            SpoolAssignment.tray_id == data.tray_id,
        )
    )
    old_assignment = old.scalar_one_or_none()
    if old_assignment is not None:
        await db.delete(old_assignment)
        await db.flush()

    if data.restore_spool_id is not None:
        # populate_existing: the hook may just have archived this very spool
        # straight on the connection, behind the identity map's back.
        result = await db.execute(
            select(Spool).where(Spool.id == data.restore_spool_id).execution_options(populate_existing=True)
        )
        spool = result.scalar_one_or_none()
        if spool is None:
            raise SlotSpoolError(404, "Spool not found")
        if spool.data_origin != SLOT_SPOOL_ORIGIN:
            raise SlotSpoolError(400, "Only a slot spool can be restored into a slot")
        # A roll is in one slot at a time: restoring it here takes it out of any other.
        elsewhere = await db.execute(select(SpoolAssignment).where(SpoolAssignment.spool_id == spool.id))
        for row in elsewhere.scalars().all():
            await db.delete(row)
        # Those deletes ran the hook again, which archives the spool on the
        # connection; read it back so clearing archived_at is a real change.
        await db.flush()
        await db.refresh(spool)
        spool.archived_at = None
        if data.remaining_grams is not None:
            label = float(spool.label_weight or FULL_SPOOL_GRAMS)
            if data.remaining_grams > label:
                spool.label_weight = int(round(data.remaining_grams))
                label = float(spool.label_weight)
            spool.weight_used = max(0.0, label - data.remaining_grams)
    else:
        remaining = FULL_SPOOL_GRAMS if data.remaining_grams is None else float(data.remaining_grams)
        label_weight = max(FULL_SPOOL_GRAMS, int(round(remaining)))
        spool = Spool(
            material=material,
            label_weight=label_weight,
            weight_used=max(0.0, label_weight - remaining),
            data_origin=SLOT_SPOOL_ORIGIN,
            added_full=remaining >= label_weight,
        )
        db.add(spool)

    # The slot was configured with these a moment ago; the spool must describe
    # the slot as the printer will report it back, or the unlink pass reads the
    # next AMS report as a different roll and drops the assignment.
    spool.material = material
    spool.rgba = rgba
    spool.color_name = _clean(data.color_name, 100)
    spool.slicer_filament = _clean(data.slicer_filament, 50)
    spool.slicer_filament_name = _clean(data.slicer_filament_name, 100)
    await db.flush()

    k = data.k_profile
    if k is not None and k.cali_idx > 0:
        await db.execute(
            delete(SpoolKProfile).where(
                SpoolKProfile.spool_id == spool.id,
                SpoolKProfile.printer_id == data.printer_id,
                SpoolKProfile.extruder == k.extruder,
                SpoolKProfile.nozzle_diameter == k.nozzle_diameter,
            )
        )
        db.add(
            SpoolKProfile(
                spool_id=spool.id,
                printer_id=data.printer_id,
                extruder=k.extruder,
                nozzle_diameter=k.nozzle_diameter,
                k_value=k.k_value,
                name=_clean(k.name, 100),
                cali_idx=k.cali_idx,
                setting_id=_clean(k.setting_id, 50),
            )
        )

    assignment = SpoolAssignment(
        spool_id=spool.id,
        printer_id=data.printer_id,
        ams_id=data.ams_id,
        tray_id=data.tray_id,
        fingerprint_color=rgba,
        fingerprint_type=material,
        assigned_by_user_id=data.assigned_by_user_id,
    )
    db.add(assignment)
    await db.execute(
        delete(SlotSpoolPrompt).where(
            SlotSpoolPrompt.printer_id == data.printer_id,
            SlotSpoolPrompt.ams_id == data.ams_id,
            SlotSpoolPrompt.tray_id == data.tray_id,
        )
    )
    from backend.app.services import spool_swaps

    await spool_swaps.record_assignment(db, data.printer_id, data.ams_id, data.tray_id, spool.id, spool_swaps.INVENTORY)
    await db.flush()
    logger.info(
        "Slot spool %d loaded into printer %d AMS%d-T%d (%s, %.0f g left%s)",
        spool.id,
        data.printer_id,
        data.ams_id,
        data.tray_id,
        material,
        max(0.0, float(spool.label_weight or 0) - float(spool.weight_used or 0)),
        ", restored" if data.restore_spool_id is not None else "",
    )
    return assignment


async def restorable_spools(
    db: AsyncSession, material: str | None = None, rgba: str | None = None, limit: int = 10
) -> list[Spool]:
    """Archived slot spools with filament left, the same colour first, newest first.

    ``material`` narrows to the slot's type as the printer names it (PLA+ and PLA
    both count as PLA), so a PETG roll is not offered for a PLA slot.
    """
    from backend.app.utils.filament_types import printer_filament_type

    result = await db.execute(
        select(Spool)
        .where(
            Spool.data_origin == SLOT_SPOOL_ORIGIN,
            Spool.archived_at.is_not(None),
            Spool.label_weight - Spool.weight_used >= RESTORABLE_MIN_GRAMS,
        )
        .order_by(Spool.archived_at.desc())
        .limit(200)
    )
    spools = list(result.scalars().all())
    if material:
        wanted = printer_filament_type(material).upper()
        spools = [s for s in spools if printer_filament_type(s.material).upper() == wanted]
    colour = (_normalize_rgba(rgba) or "")[:6]
    if colour:
        spools.sort(key=lambda s: (s.rgba or "")[:6].upper() != colour)
    return spools[:limit]
