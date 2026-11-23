"""Slot spools (fork): load a roll into an AMS slot, answer "same roll?", restore one.

How slot spools work is in services/slot_spools.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import (
    ApiKeyActor,
    RequestActor,
    RequestPrinterScope,
    RequirePermissionIfAuthEnabled,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.printer_scope import PrinterScope
from backend.app.core.websocket import ws_manager
from backend.app.models.printer import Printer
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.models.user import User
from backend.app.schemas.spool import SpoolAssignmentResponse
from backend.app.services import slot_spools as service, slot_unlink_grace
from backend.app.services.ams_assignment_lock import get_ams_assignment_lock

router = APIRouter(prefix="/slot-spools", tags=["slot-spools"])


class KProfileIn(BaseModel):
    cali_idx: int
    k_value: float = Field(ge=0, le=10)
    extruder: int = Field(default=0, ge=0, le=15)
    nozzle_diameter: str = Field(default="0.4", max_length=10)
    name: str | None = Field(default=None, max_length=100)
    setting_id: str | None = Field(default=None, max_length=50)


class SlotSpoolLoadRequest(BaseModel):
    printer_id: int
    ams_id: int = Field(ge=0, le=255)
    tray_id: int = Field(ge=0, le=15)
    material: str = Field(min_length=1, max_length=50)
    rgba: str | None = Field(default=None, max_length=9)
    color_name: str | None = Field(default=None, max_length=100)
    slicer_filament: str | None = Field(default=None, max_length=50)
    slicer_filament_name: str | None = Field(default=None, max_length=100)
    # Grams on the roll; omitted = a full roll, or what a restored roll had.
    remaining_grams: float | None = Field(default=None, ge=0, le=100000)
    restore_spool_id: int | None = None
    k_profile: KProfileIn | None = None


class SlotSpoolPromptResponse(BaseModel):
    printer_id: int
    ams_id: int
    tray_id: int
    spool_id: int
    created_at: datetime

    class Config:
        from_attributes = True


class RestorableSpoolResponse(BaseModel):
    id: int
    material: str
    color_name: str | None = None
    rgba: str | None = None
    slicer_filament_name: str | None = None
    remaining_grams: float
    label_weight: int
    archived_at: datetime | None = None


@router.get("/prompts", response_model=list[SlotSpoolPromptResponse])
async def list_prompts(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Slots emptied and refilled under their slot spool, waiting for "same roll?"."""
    return [p for p in await service.list_prompts(db) if printer_scope.allows(p.printer_id)]


@router.post("/prompts/{printer_id}/{ams_id}/{tray_id}/same")
async def keep_same_roll(
    printer_id: int,
    ams_id: int,
    tray_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """The same roll went back in: keep counting on the slot's spool."""
    printer_scope.ensure(printer_id)
    cleared = await service.clear_prompt(db, printer_id, ams_id, tray_id)
    await db.commit()
    if cleared:
        await ws_manager.broadcast({"type": "slot_spool_prompts_changed", "printer_id": printer_id})
    return {"status": "ok", "cleared": cleared}


@router.get("/restorable", response_model=list[RestorableSpoolResponse])
async def list_restorable(
    material: str | None = Query(default=None, max_length=50),
    rgba: str | None = Query(default=None, max_length=9),
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    """Rolls taken out of a slot with filament left on them, to put back in one."""
    return [
        RestorableSpoolResponse(
            id=s.id,
            material=s.material,
            color_name=s.color_name,
            rgba=s.rgba,
            slicer_filament_name=s.slicer_filament_name,
            remaining_grams=max(0.0, float(s.label_weight or 0) - float(s.weight_used or 0)),
            label_weight=s.label_weight,
            archived_at=s.archived_at,
        )
        for s in await service.restorable_spools(db, material=material, rgba=rgba)
    ]


@router.post("", response_model=SpoolAssignmentResponse)
@router.post("/", response_model=SpoolAssignmentResponse, include_in_schema=False)
async def load_slot_spool(
    data: SlotSpoolLoadRequest,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
    actor: User | ApiKeyActor | None = RequestActor,
):
    """Start counting the roll in a slot the printer has just been configured for.

    Sends nothing to the printer: the slot dialog has already set its preset and
    K profile. Makes (or restores) the slot spool and assigns it to the slot.
    """
    from backend.app.api.routes.inventory import spool_response_loads

    printer_scope.ensure(data.printer_id)
    if (await db.execute(select(Printer.id).where(Printer.id == data.printer_id))).scalar_one_or_none() is None:
        raise HTTPException(404, "Printer not found")
    if await service_spoolman_mode(db):
        raise HTTPException(409, "Slot spools need the built-in inventory (Spoolman mode is on)")

    user_id = current_user.id if current_user is not None else None
    if user_id is None and isinstance(actor, ApiKeyActor):
        user_id = actor.id
    k = data.k_profile
    load = service.SlotSpoolLoad(
        printer_id=data.printer_id,
        ams_id=data.ams_id,
        tray_id=data.tray_id,
        material=data.material,
        rgba=data.rgba,
        color_name=data.color_name,
        slicer_filament=data.slicer_filament,
        slicer_filament_name=data.slicer_filament_name,
        remaining_grams=data.remaining_grams,
        restore_spool_id=data.restore_spool_id,
        k_profile=service.KProfileChoice(
            cali_idx=k.cali_idx,
            k_value=k.k_value,
            extruder=k.extruder,
            nozzle_diameter=k.nozzle_diameter,
            name=k.name,
            setting_id=k.setting_id,
        )
        if k is not None
        else None,
        assigned_by_user_id=user_id,
    )
    async with get_ams_assignment_lock(data.printer_id):
        try:
            assignment = await service.load_slot_spool(db, load)
        except service.SlotSpoolError as exc:
            await db.rollback()
            raise HTTPException(exc.status_code, exc.detail) from exc
        await db.commit()
        assignment_id = assignment.id
    slot_unlink_grace.forget_slot(data.printer_id, data.ams_id, data.tray_id)

    result = await db.execute(
        select(SpoolAssignment)
        .options(
            selectinload(SpoolAssignment.spool).options(*spool_response_loads()),
            selectinload(SpoolAssignment.printer),
        )
        .where(SpoolAssignment.id == assignment_id)
        .execution_options(populate_existing=True)
    )
    response = SpoolAssignmentResponse.model_validate(result.scalar_one())
    response.configured = True

    await ws_manager.broadcast(
        {
            "type": "spool_assignment_changed",
            "printer_id": data.printer_id,
            "ams_id": data.ams_id,
            "tray_id": data.tray_id,
        }
    )
    await ws_manager.broadcast({"type": "inventory_changed"})
    await ws_manager.broadcast({"type": "slot_spool_prompts_changed", "printer_id": data.printer_id})
    return response


async def service_spoolman_mode(db: AsyncSession) -> bool:
    from backend.app.services.inventory_mode import spoolman_owns_assignments

    return await spoolman_owns_assignments(db)
