"""Printer tags (fork): read and set a printer's tags, read each job's.

How tags route queue jobs is in services/printer_tags. The tags themselves
are the library's tag catalog (/library/tags).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import (
    ApiKeyActor,
    RequestPrinterScope,
    RequirePermissionIfAuthEnabled,
    RequirePrinterPermissionIfAuthEnabled,
    require_ownership_permission,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.library import LibraryFile, LibraryFileTag
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.services.printer_tags import TagRouting, check_tag_ids, read_printer_tags, write_printer_tags

router = APIRouter(prefix="/printer-tags", tags=["printer-tags"])

MAX_TAGS_PER_PRINTER = 50


class PrinterTagsResponse(BaseModel):
    printer_id: int
    tag_ids: list[int]
    # Takes only jobs that ask for one of its tags.
    exclusive: bool


class PrinterTagsUpdate(BaseModel):
    tag_ids: list[int] = Field(default_factory=list, max_length=MAX_TAGS_PER_PRINTER)
    exclusive: bool = False


class FileTagsResponse(BaseModel):
    file_id: int
    # The file's tags that some printer carries: what a job for it asks for.
    tag_ids: list[int]


class QueueItemTagsResponse(BaseModel):
    queue_item_id: int
    tag_ids: list[int]
    # True: given in the print dialog. False: read from the job's file.
    overridden: bool


@router.get("", response_model=list[PrinterTagsResponse])
@router.get("/", response_model=list[PrinterTagsResponse])
async def list_printer_tags(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Every tagged printer the caller can see."""
    return [
        PrinterTagsResponse(printer_id=pid, tag_ids=sorted(tags.tag_ids), exclusive=tags.exclusive)
        for pid, tags in sorted((await read_printer_tags(db)).items())
        if tags.tag_ids and printer_scope.allows(pid)
    ]


@router.put("/{printer_id}", response_model=PrinterTagsResponse)
async def set_printer_tags(
    printer_id: int,
    data: PrinterTagsUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePrinterPermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
):
    """Replace a printer's tags. An empty list untags it."""
    if (await db.execute(select(Printer.id).where(Printer.id == printer_id))).scalar_one_or_none() is None:
        raise HTTPException(404, "Printer not found")
    if missing := await check_tag_ids(db, data.tag_ids):
        raise HTTPException(400, f"Unknown tag: {', '.join(map(str, missing))}")
    tags = await write_printer_tags(db, printer_id, data.tag_ids, data.exclusive)
    await db.commit()
    return PrinterTagsResponse(printer_id=printer_id, tag_ids=sorted(tags.tag_ids), exclusive=tags.exclusive)


@router.get("/queue", response_model=list[QueueItemTagsResponse])
async def list_queue_item_tags(
    db: AsyncSession = Depends(get_db, scope="function"),
    auth_result: tuple[User | ApiKeyActor | None, bool] = Depends(
        require_ownership_permission(Permission.QUEUE_READ_ALL, Permission.QUEUE_READ_OWN)
    ),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """The tags each pending job asks for, as the queue reads them (jobs asking for none are left out)."""
    user, can_read_all = auth_result
    query = (
        select(PrintQueueItem).options(selectinload(PrintQueueItem.variants)).where(PrintQueueItem.status == "pending")
    )
    if user is not None and not can_read_all:
        query = query.where(PrintQueueItem.created_by_id == user.id)
    if (clause := printer_scope.where(PrintQueueItem.printer_id)) is not None:
        query = query.where(clause)
    items = list((await db.execute(query)).scalars().all())
    routing = await TagRouting.load(db, items)
    result = []
    for item in items:
        wanted = routing.wanted(item)
        if wanted or routing.is_overridden(item):
            result.append(
                QueueItemTagsResponse(
                    queue_item_id=item.id, tag_ids=sorted(wanted), overridden=routing.is_overridden(item)
                )
            )
    return result


@router.get("/files", response_model=list[FileTagsResponse])
async def list_file_routing_tags(
    file_id: list[int] = Query(default_factory=list, max_length=200),
    db: AsyncSession = Depends(get_db, scope="function"),
    auth_result: tuple[User | ApiKeyActor | None, bool] = Depends(
        require_ownership_permission(Permission.LIBRARY_READ_ALL, Permission.LIBRARY_READ_OWN)
    ),
):
    """The tags a job for each file would ask for, for the print dialog to show."""
    user, can_read_all = auth_result
    used = frozenset().union(*(t.tag_ids for t in (await read_printer_tags(db)).values()))
    if not file_id or not used:
        return []
    query = select(LibraryFileTag.file_id, LibraryFileTag.tag_id).where(
        LibraryFileTag.file_id.in_(file_id), LibraryFileTag.tag_id.in_(used)
    )
    if user is not None and not can_read_all:
        query = query.join(LibraryFile, LibraryFile.id == LibraryFileTag.file_id).where(
            LibraryFile.created_by_id == user.id
        )
    by_file: dict[int, set[int]] = {}
    for fid, tag_id in (await db.execute(query)).all():
        by_file.setdefault(fid, set()).add(tag_id)
    return [FileTagsResponse(file_id=fid, tag_ids=sorted(tags)) for fid, tags in sorted(by_file.items())]
