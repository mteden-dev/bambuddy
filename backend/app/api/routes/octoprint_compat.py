"""Send from OrcaSlicer to Bambuddy, the way OrcaSlicer sends to SimplyPrint (fork).

OrcaSlicer's SimplyPrint upload cannot be pointed anywhere else: its addresses
and OAuth client are compiled in. So Bambuddy answers as an **OctoPrint** print
host instead, which OrcaSlicer can point at any URL with an API key:

- ``GET /api/version`` -- OrcaSlicer's *Test* button, and its check before every
  upload. The reply needs ``api``, and ``text`` must start with ``OctoPrint``.
- ``POST /api/files/local`` -- the upload: multipart ``file``, ``path``,
  ``print`` ("true" for *Upload and print*) and, for a ``.gcode.3mf``, the
  1-based ``plateindex`` of the plate the user sliced. OrcaSlicer only looks
  at the status code.

Both live outside ``/api/v1`` (where they cannot collide with Bambuddy's own
API), so the one Bambuddy address serves the upload and OrcaSlicer's Device tab.

The upload lands in the library's inbox folder ("OrcaSlicer", or the folder
the ``slicer_inbox_folder_id`` setting names), marked ``source_type =
"orcaslicer"`` with the plate and the print flag kept in its metadata. The
uploader is told over the WebSocket (``slicer_upload``), and the app asks them
what to do with it: print, queue, keep it in the library or discard it. A file
is waiting for that decision while it is still in the folder it was uploaded
to, not in the trash, and not referenced by a queue item -- see
``pending_slicer_uploads``. Nothing here changes the database schema.

The dialog opens in every session of the uploader, so two devices can decide
on one file. Whatever decides it says so over the WebSocket
(``slicer_upload_decided``), the queue refuses a second job for a waiting
upload unless it comes from the same decision (``claim_slicer_upload``), and
the inbox's own discard refuses a file a queue job uses.

The API key needs ``can_manage_library`` only: printing and queueing are done
by the signed-in user in the app, not by the key.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.app.api.routes.library import upload_file
from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.core.auth import (
    ApiKeyActor,
    RequestActor,
    require_any_permission_if_auth_enabled,
    require_ownership_permission,
    require_permission_if_auth_enabled,
)
from backend.app.core.config import APP_VERSION
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.websocket import ws_manager
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.user import User
from backend.app.services.library_folder_access import can_write_folder, default_import_folder
from backend.app.services.library_trash import library_trash_service

logger = logging.getLogger(__name__)

# The marker on an uploaded file and the metadata key holding what came with it.
SLICER_UPLOAD_SOURCE = "orcaslicer"
SLICER_UPLOAD_META_KEY = "slicer_upload"
# The inbox folder made on the first upload when no folder is configured.
INBOX_FOLDER_NAME = "OrcaSlicer"
INBOX_FOLDER_SETTING = "slicer_inbox_folder_id"
# The plate numbers a bundle can name; anything else is ignored as unknown.
_MAX_PLATE_INDEX = 999
# What the WebSocket message is called (handled in frontend useWebSocket).
SLICER_UPLOAD_WS_TYPE = "slicer_upload"
# Sent when a waiting upload was queued, kept or discarded, so the dialog in
# the uploader's other sessions moves on instead of offering it again.
SLICER_DECIDED_WS_TYPE = "slicer_upload_decided"
# The longest decision id a client may send; anything longer is cut.
_MAX_CLAIM_LENGTH = 64

# OctoPrint's own version is what OrcaSlicer reads; 1.1.0 or newer is required.
_OCTOPRINT_API_VERSION = "0.1"
_OCTOPRINT_SERVER_VERSION = "1.10.0"

# OctoPrint-compatible routes: mounted at the root, outside the API prefix.
router = APIRouter(tags=["octoprint-compat"])
# The app's side of it: mounted under the API prefix.
inbox_router = APIRouter(prefix="/slicer-inbox", tags=["slicer-inbox"])


# ---------------------------------------------------------------------------
# OrcaSlicer's Device tab
# ---------------------------------------------------------------------------

_SESSION_KEEPS_PATHS = frozenset({"/api/version", "/api/files/local"})


class PreferSessionOverInjectedApiKey:
    """Judge a request carrying both a session token and an API key by the session.

    OrcaSlicer shows the OctoPrint host's web UI in its Device tab and wraps
    ``window.fetch`` there so every request carries the host's ``X-API-Key``
    (``PrinterWebView::SendAPIKey``). Bambuddy reads an API key before a login
    token, so the app in that tab would run as the upload key -- which only
    may add files to the library -- instead of as the user who signed in.

    When a request has a session token (``Authorization: Bearer <JWT>``) as
    well as an ``X-API-Key``, the key is dropped and the request is judged by
    the session alone. A request with only a key (OrcaSlicer's uploads,
    scripts, Home Assistant) or only a session is untouched, and nothing gets
    in that did not before: the session must still be valid on its own. A
    ``Bearer bb_...`` value is itself an API key, so such a request is left
    as it is.
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("path") not in _SESSION_KEEPS_PATHS:
            headers = scope.get("headers") or []
            has_api_key = False
            has_session = False
            for name, value in headers:
                if name == b"x-api-key":
                    has_api_key = True
                elif name == b"authorization":
                    token = value.strip()
                    if token[:7].lower() == b"bearer " and not token[7:].lstrip().startswith(b"bb_"):
                        has_session = bool(token[7:].strip())
            if has_api_key and has_session:
                scope = dict(scope)
                scope["headers"] = [(name, value) for name, value in headers if name != b"x-api-key"]
        await self.app(scope, receive, send)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_plate_index(raw: str | None) -> int | None:
    """OrcaSlicer's 1-based ``plateindex``, or None when absent or not a plate number."""
    if raw is None:
        return None
    text = raw.strip()
    if not (text.isascii() and text.isdigit()):
        return None
    value = int(text)
    return value if 1 <= value <= _MAX_PLATE_INDEX else None


def parse_print_flag(raw: str | None) -> bool:
    """OctoPrint's ``print`` form field: "true" for *Upload and print*."""
    return (raw or "").strip().lower() in ("true", "1", "yes", "on")


def _parse_folder_id(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


async def resolve_inbox_folder(db: AsyncSession, actor: User | ApiKeyActor | None) -> LibraryFolder:
    """The folder an upload from the slicer goes into.

    The folder the ``slicer_inbox_folder_id`` setting names, while it exists.
    Without one, the top-level "OrcaSlicer" folder (made shared on the first
    upload, as the MakerWorld import's folder is), which is then remembered in
    the setting so the settings page can show and change it. A configured
    folder the uploader may not write to is refused rather than silently
    replaced, so files never scatter over several folders.
    """
    configured_id = _parse_folder_id(await get_setting(db, INBOX_FOLDER_SETTING))
    if configured_id is not None:
        folder = (await db.execute(select(LibraryFolder).where(LibraryFolder.id == configured_id))).scalar_one_or_none()
        if folder is not None:
            if not can_write_folder(folder, actor):
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"The API key's owner may not add files to the inbox folder '{folder.name}'. "
                        "Share the folder or choose another one in Bambuddy's settings."
                    ),
                )
            return folder
    folder = await default_import_folder(db, INBOX_FOLDER_NAME, actor)  # type: ignore[arg-type]
    if folder.shared:
        await set_setting(db, INBOX_FOLDER_SETTING, str(folder.id))
    return folder


def slicer_upload_info(file: LibraryFile) -> dict | None:
    """What came with an upload from the slicer, or None for any other file."""
    if file.source_type != SLICER_UPLOAD_SOURCE:
        return None
    info = (file.file_metadata or {}).get(SLICER_UPLOAD_META_KEY)
    return info if isinstance(info, dict) else None


def _is_waiting(file: LibraryFile) -> bool:
    """Still in the folder it was uploaded to: not yet kept elsewhere."""
    info = slicer_upload_info(file)
    if info is None:
        return False
    return info.get("folder_id") == file.folder_id


async def pending_slicer_uploads(db: AsyncSession, actor: User | ApiKeyActor | None) -> list[LibraryFile]:
    """Uploads from the slicer that wait for ``actor`` to decide, oldest first.

    Waiting means: still in the folder it was uploaded to, not in the trash,
    and no queue item points at it (queueing or printing it creates one, and
    the print's cleanup then removes the file). With auth on a user decides on
    their own uploads; an administrator also on those of a key without owner.
    """
    query = LibraryFile.active().where(LibraryFile.source_type == SLICER_UPLOAD_SOURCE)
    if actor is not None:
        if getattr(actor, "is_admin", False):
            query = query.where((LibraryFile.created_by_id == actor.id) | LibraryFile.created_by_id.is_(None))
        elif actor.id is not None:
            query = query.where(LibraryFile.created_by_id == actor.id)
        else:
            return []
    files = [f for f in (await db.execute(query.order_by(LibraryFile.id))).scalars().all() if _is_waiting(f)]
    if not files:
        return []
    queued = set(
        (
            await db.execute(
                select(PrintQueueItem.library_file_id).where(PrintQueueItem.library_file_id.in_([f.id for f in files]))
            )
        )
        .scalars()
        .all()
    )
    return [f for f in files if f.id not in queued]


def _clean_claim(claim: str | None) -> str | None:
    text = (claim or "").strip()[:_MAX_CLAIM_LENGTH]
    return text or None


async def _queue_item_count(db: AsyncSession, file_id: int) -> int:
    result = await db.execute(select(PrintQueueItem.id).where(PrintQueueItem.library_file_id == file_id))
    return len(result.scalars().all())


async def refuse_trashing_queued_upload(db: AsyncSession, library_file: LibraryFile) -> None:
    """409 when the file manager would trash a waiting upload that a pending queue job prints.

    The inbox's own discard refuses the same (``discard_slicer_upload``);
    ``DELETE /library/files/{id}`` calls this so the trash there cannot leave
    the job with nothing to print. Any other file is none of this.
    """
    if slicer_upload_info(library_file) is None or not _is_waiting(library_file):
        return
    pending = await db.execute(
        select(PrintQueueItem.id).where(
            PrintQueueItem.library_file_id == library_file.id, PrintQueueItem.status == "pending"
        )
    )
    if pending.first() is not None:
        raise HTTPException(
            status_code=409,
            detail="This OrcaSlicer upload waits in the queue; cancel its job before moving it to the trash.",
        )


async def claim_slicer_upload(db: AsyncSession, library_file: LibraryFile, claim: str | None) -> bool:
    """Refuse a second queue job for an upload another decision already queued.

    Called by the queue (``add_to_queue``) for the file a job is about to be
    created for, under the queue's insert lock. A file that is no slicer
    upload, or one already kept in another folder, is none of this: True is
    returned only for an upload still waiting in its inbox, so the caller
    announces the decision once the job is committed.

    ``claim`` is the decision id the app sends with the jobs of one decision
    (one dialog printing the upload on several printers sends the same one).
    The first job of a decision stores it on the file; a later job for the same
    file passes only with that id. One from another device, or with none, is
    answered 409: the upload is already in the queue.
    """
    info = slicer_upload_info(library_file)
    if info is None or not _is_waiting(library_file):
        return False
    claim = _clean_claim(claim)
    if await _queue_item_count(db, library_file.id):
        if claim is None or info.get("claim") != claim:
            raise HTTPException(
                status_code=409,
                detail="This OrcaSlicer upload is already in the queue (it was handled on another device).",
            )
        return True
    if info.get("claim") != claim:
        metadata = dict(library_file.file_metadata or {})
        metadata[SLICER_UPLOAD_META_KEY] = {**info, "claim": claim}
        library_file.file_metadata = metadata
    return True


async def announce_slicer_upload_decided(
    library_file: LibraryFile,
    decision: str,
    actor: User | ApiKeyActor | None,
    claim: str | None = None,
) -> None:
    """Tell the uploader's sessions (and the decider's) that an upload was decided.

    ``decision`` is "queued", "kept", "discarded" or "restored" (an undone
    discard, which waits again). ``claim`` comes back as sent, so the session
    that decided can tell its own decision from another device's.
    """
    message = {
        "type": SLICER_DECIDED_WS_TYPE,
        "data": {"file_id": library_file.id, "decision": decision, "claim": _clean_claim(claim)},
    }
    owner = library_file.created_by_id
    actor_id = getattr(actor, "id", None)
    if owner is None:
        # A key without owner: every session may be asked about it.
        await ws_manager.broadcast_to_user(None, message)
        return
    await ws_manager.broadcast_to_users({i for i in (owner, actor_id) if i is not None}, message)


# ---------------------------------------------------------------------------
# OctoPrint-compatible routes
# ---------------------------------------------------------------------------


@router.get("/api/version")
async def octoprint_version(
    _: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
):
    """OctoPrint's version endpoint, which OrcaSlicer calls before every upload.

    Gated like the upload, so OrcaSlicer's *Test* button also tells whether
    the key may upload.
    """
    return {
        "api": _OCTOPRINT_API_VERSION,
        "server": _OCTOPRINT_SERVER_VERSION,
        "text": f"OctoPrint {_OCTOPRINT_SERVER_VERSION} (Bambuddy {APP_VERSION})",
    }


@router.post("/api/files/local", status_code=201)
async def octoprint_upload(
    file: UploadFile = File(...),
    print_flag: str | None = Form(default=None, alias="print"),
    path: str | None = Form(default=None),
    plateindex: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = Depends(require_permission_if_auth_enabled(Permission.LIBRARY_UPLOAD)),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """OctoPrint's upload endpoint: the file goes into the library's inbox folder.

    Only ``.gcode.3mf`` is taken: Bambu printers print nothing else over the
    network, and it carries the filament list the print dialog maps to the
    AMS. OrcaSlicer sends one when *Use 3MF instead of G-code* is set in the
    printer preset. ``path`` (the folder typed in OrcaSlicer's send dialog) is
    ignored: everything lands in the inbox and is filed from there.
    """
    filename = file.filename or ""
    if not filename.lower().endswith(".gcode.3mf"):
        raise HTTPException(
            status_code=415,
            detail=(
                "Bambuddy takes sliced .gcode.3mf files only. In OrcaSlicer, tick "
                "'Use 3MF instead of G-code' in the printer preset (Basic information > Advanced)."
            ),
        )

    folder = await resolve_inbox_folder(db, actor)
    uploaded = await upload_file(
        file=file,
        folder_id=folder.id,
        generate_stl_thumbnails=False,
        db=db,
        current_user=current_user,
        actor=actor,
    )

    plate = parse_plate_index(plateindex)
    start_print = parse_print_flag(print_flag)
    library_file = (await db.execute(select(LibraryFile).where(LibraryFile.id == uploaded.id))).scalar_one()
    metadata = dict(library_file.file_metadata or {})
    metadata[SLICER_UPLOAD_META_KEY] = {"plate": plate, "print": start_print, "folder_id": folder.id}
    library_file.file_metadata = metadata
    library_file.source_type = SLICER_UPLOAD_SOURCE
    await db.commit()

    logger.info(
        "Slicer upload %r stored as library file %s in folder %s (plate=%s, print=%s, path=%r)",
        library_file.filename,
        library_file.id,
        folder.id,
        plate,
        start_print,
        path or "",
    )

    await ws_manager.broadcast_to_user(
        actor.id if actor is not None else None,
        {
            "type": SLICER_UPLOAD_WS_TYPE,
            "data": {
                "file_id": library_file.id,
                "filename": library_file.filename,
                "plate": plate,
                "print": start_print,
            },
        },
    )

    # OrcaSlicer reads only the status; this is OctoPrint's own reply shape.
    return JSONResponse(
        status_code=201,
        content={
            "done": True,
            "files": {
                "local": {
                    "name": library_file.filename,
                    "origin": "local",
                    "refs": {"resource": f"/api/v1/library/files/{library_file.id}"},
                }
            },
        },
    )


# ---------------------------------------------------------------------------
# The app's side
# ---------------------------------------------------------------------------


class PendingSlicerUpload(BaseModel):
    """An upload from the slicer waiting for a decision."""

    id: int
    filename: str
    folder_id: int | None
    plate: int | None
    print: bool
    sliced_for_model: str | None
    print_time_seconds: int | None
    filament_used_grams: float | None
    created_at: datetime


def _as_int(value) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _as_float(value) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


@inbox_router.get("/pending", response_model=list[PendingSlicerUpload])
async def list_pending_slicer_uploads(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = Depends(
        require_any_permission_if_auth_enabled(Permission.LIBRARY_READ_OWN, Permission.LIBRARY_READ_ALL)
    ),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """The caller's uploads from the slicer that wait for a decision, oldest first."""
    out: list[PendingSlicerUpload] = []
    for file in await pending_slicer_uploads(db, actor):
        metadata = file.file_metadata or {}
        info = slicer_upload_info(file) or {}
        out.append(
            PendingSlicerUpload(
                id=file.id,
                filename=file.filename,
                folder_id=file.folder_id,
                plate=parse_plate_index(str(info["plate"])) if info.get("plate") is not None else None,
                print=bool(info.get("print")),
                sliced_for_model=metadata.get("sliced_for_model") or None,
                print_time_seconds=_as_int(metadata.get("print_time_seconds")),
                filament_used_grams=_as_float(metadata.get("filament_used_grams")),
                created_at=file.created_at,
            )
        )
    return out


class SlicerUploadDecision(BaseModel):
    """What the app sends with a decision on a waiting upload."""

    # The decision id (see ``claim_slicer_upload``), echoed in the broadcast.
    claim: str | None = None


async def _owned_inbox_file(
    db: AsyncSession,
    file_id: int,
    user: User | ApiKeyActor | None,
    can_modify_all: bool,
    *,
    trashed: bool,
) -> LibraryFile:
    """The upload ``file_id`` still in its inbox, active or trashed, that the caller may delete."""
    query = select(LibraryFile).where(
        LibraryFile.id == file_id,
        LibraryFile.source_type == SLICER_UPLOAD_SOURCE,
        LibraryFile.deleted_at.isnot(None) if trashed else LibraryFile.deleted_at.is_(None),
    )
    file = (await db.execute(query)).scalar_one_or_none()
    if file is None or not _is_waiting(file):
        raise HTTPException(status_code=404, detail="No such upload from the slicer waits here")
    if not can_modify_all and (user is None or file.created_by_id != user.id):
        raise HTTPException(status_code=403, detail="You can only discard your own uploads")
    return file


@inbox_router.post("/{file_id}/discard")
async def discard_slicer_upload(
    file_id: int,
    body: SlicerUploadDecision | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    auth_result: tuple[User | ApiKeyActor | None, bool] = Depends(
        require_ownership_permission(Permission.LIBRARY_DELETE_ALL, Permission.LIBRARY_DELETE_OWN)
    ),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """Move a waiting upload to the library trash ("Discard" in the app).

    Refused with 409 while a queue job uses the file (it was queued on another
    device meanwhile): trashing it would leave that job with nothing to print.
    """
    user, can_modify_all = auth_result
    file = await _owned_inbox_file(db, file_id, user, can_modify_all, trashed=False)
    if await _queue_item_count(db, file.id):
        raise HTTPException(
            status_code=409,
            detail="This OrcaSlicer upload is in the queue (it was handled on another device); it was not discarded.",
        )
    file.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    logger.info("Slicer upload %s discarded to the trash", file.id)
    await announce_slicer_upload_decided(file, "discarded", actor, body.claim if body else None)
    return {"status": "success", "id": file.id}


@inbox_router.post("/{file_id}/restore")
async def restore_slicer_upload(
    file_id: int,
    body: SlicerUploadDecision | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    auth_result: tuple[User | ApiKeyActor | None, bool] = Depends(
        require_ownership_permission(Permission.LIBRARY_DELETE_ALL, Permission.LIBRARY_DELETE_OWN)
    ),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """Undo "Discard": take a discarded upload out of the trash, so it waits again."""
    user, can_modify_all = auth_result
    file = await _owned_inbox_file(db, file_id, user, can_modify_all, trashed=True)
    await library_trash_service.restore(db, file)
    logger.info("Slicer upload %s restored from the trash", file.id)
    await announce_slicer_upload_decided(file, "restored", actor, body.claim if body else None)
    return {"status": "success", "id": file.id}


@inbox_router.post("/{file_id}/kept")
async def announce_slicer_upload_kept(
    file_id: int,
    body: SlicerUploadDecision | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = Depends(
        require_any_permission_if_auth_enabled(Permission.LIBRARY_UPDATE_OWN, Permission.LIBRARY_UPDATE_ALL)
    ),
    actor: User | ApiKeyActor | None = RequestActor,
):
    """Say that an upload was kept in another folder (the app moves it itself).

    Only for an upload of the caller's that really left its inbox; anything
    else is 404, so no session is told of a decision that did not happen.
    """
    file = (
        await db.execute(
            LibraryFile.active().where(LibraryFile.id == file_id, LibraryFile.source_type == SLICER_UPLOAD_SOURCE)
        )
    ).scalar_one_or_none()
    mine = actor is None or getattr(actor, "is_admin", False) or file is None or file.created_by_id == actor.id
    if file is None or slicer_upload_info(file) is None or _is_waiting(file) or not mine:
        raise HTTPException(status_code=404, detail="No such upload from the slicer was kept")
    await announce_slicer_upload_decided(file, "kept", actor, body.claim if body else None)
    return {"status": "success", "id": file.id}
