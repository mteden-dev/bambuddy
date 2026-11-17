"""OrcaSlicer uploads to Bambuddy as to an OctoPrint host (fork, ORCA_SLICER_UPLOAD.md).

Pinned here:

- ``GET /api/version`` answers in the shape OrcaSlicer checks (``api``, and a
  ``text`` starting with "OctoPrint"), behind the same gate as the upload.
- ``POST /api/files/local`` stores a ``.gcode.3mf`` in the inbox folder, marks
  it as a slicer upload with its plate and print flag, and tells its uploader
  over the WebSocket. Anything else is refused with OrcaSlicer's remedy.
- ``GET /api/v1/slicer-inbox/pending`` lists a user's uploads still waiting for
  a decision: kept elsewhere, queued or trashed, they leave the list.
- A request carrying both a session token and an API key (OrcaSlicer's Device
  tab adds the key to every fetch) is judged by the session.
"""

from __future__ import annotations

import io
import secrets
import zipfile
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import generate_api_key
from backend.app.models.api_key import APIKey
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.models.user import User

_PW = "Aa1!" + secrets.token_urlsafe(12)  # pragma: allowlist secret
_SLICE_INFO = (
    '<?xml version="1.0" encoding="UTF-8"?><config><plate>'
    '<metadata key="index" value="{plate}"/>'
    '<metadata key="printer_model_id" value="C12"/>'
    '<metadata key="prediction" value="3600"/>'
    '<metadata key="weight" value="12.5"/>'
    "</plate></config>"
)


def _sliced_3mf(plate: int = 1) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"Metadata/plate_{plate}.gcode", "; G-code\nG28\n")
        zf.writestr("Metadata/slice_info.config", _SLICE_INFO.format(plate=plate))
    return buf.getvalue()


def _upload_form(filename: str = "Cube_plate_2.gcode.3mf", *, plate: str | None = "2", start: str = "true"):
    data = {"print": start, "path": ""}
    if plate is not None:
        data["plateindex"] = plate
    return {"files": {"file": (filename, _sliced_3mf(2), "application/octet-stream")}, "data": data}


async def _setup_admin(client: AsyncClient, username: str = "orcaadmin") -> str:
    await client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": username, "admin_password": _PW},
    )
    login = await client.post("/api/v1/auth/login", json={"username": username, "password": _PW})
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


async def _user(db: AsyncSession, username: str) -> User:
    return (await db.execute(select(User).where(User.username == username))).scalar_one()


async def _make_key(db: AsyncSession, owner: User, *, can_manage_library: bool = True, **scopes) -> str:
    full_key, key_hash, key_prefix = generate_api_key()
    db.add(
        APIKey(
            name=f"orca-{key_prefix}",
            key_hash=key_hash,
            key_prefix=key_prefix,
            user_id=owner.id,
            can_manage_library=can_manage_library,
            can_queue=scopes.get("can_queue", False),
            can_read_status=scopes.get("can_read_status", False),
            can_control_printer=False,
        )
    )
    await db.commit()
    return full_key


async def _setting(db: AsyncSession, key: str) -> str | None:
    db.expire_all()
    row = (await db.execute(select(Settings).where(Settings.key == key))).scalar_one_or_none()
    return row.value if row else None


async def _file(db: AsyncSession, file_id: int) -> LibraryFile:
    db.expire_all()
    return (await db.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one()


async def _only_slicer_file(db: AsyncSession) -> LibraryFile:
    db.expire_all()
    return (await db.execute(select(LibraryFile).where(LibraryFile.source_type == "orcaslicer"))).scalar_one()


class TestVersion:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_answers_like_octoprint_with_auth_off(self, async_client: AsyncClient):
        response = await async_client.get("/api/version")
        assert response.status_code == 200
        body = response.json()
        assert body["api"]
        assert body["text"].startswith("OctoPrint")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_gated_like_the_upload(self, async_client: AsyncClient, db_session: AsyncSession):
        await _setup_admin(async_client)
        admin = await _user(db_session, "orcaadmin")
        good = await _make_key(db_session, admin)
        weak = await _make_key(db_session, admin, can_manage_library=False, can_read_status=True)

        assert (await async_client.get("/api/version")).status_code == 401
        assert (await async_client.get("/api/version", headers={"X-Api-Key": weak})).status_code == 403
        assert (await async_client.get("/api/version", headers={"X-Api-Key": "bb_nonsense"})).status_code == 401
        ok = await async_client.get("/api/version", headers={"X-Api-Key": good})
        assert ok.status_code == 200
        assert ok.json()["text"].startswith("OctoPrint")


class TestUpload:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stores_in_the_inbox_and_tells_the_uploader(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        await _setup_admin(async_client)
        admin = await _user(db_session, "orcaadmin")
        admin_id = admin.id
        key = await _make_key(db_session, admin)

        with patch(
            "backend.app.api.routes.octoprint_compat.ws_manager.broadcast_to_user", new_callable=AsyncMock
        ) as broadcast:
            response = await async_client.post("/api/files/local", headers={"X-Api-Key": key}, **_upload_form())

        assert response.status_code == 201, response.text
        assert response.json()["done"] is True
        assert response.json()["files"]["local"]["name"] == "Cube_plate_2.gcode.3mf"

        stored = await _only_slicer_file(db_session)
        folder = (
            await db_session.execute(select(LibraryFolder).where(LibraryFolder.id == stored.folder_id))
        ).scalar_one()
        assert folder.name == "OrcaSlicer"
        assert folder.parent_id is None
        assert folder.shared is True
        assert stored.created_by_id == admin_id
        assert stored.file_metadata["slicer_upload"] == {"plate": 2, "print": True, "folder_id": folder.id}
        assert stored.file_metadata["sliced_for_model"] == "P1S"
        folder_id, stored_id = folder.id, stored.id
        # The inbox is remembered, so the settings page can show it.
        assert await _setting(db_session, "slicer_inbox_folder_id") == str(folder_id)

        broadcast.assert_awaited_once()
        user_id, message = broadcast.await_args.args
        assert user_id == admin_id
        assert message == {
            "type": "slicer_upload",
            "data": {"file_id": stored_id, "filename": "Cube_plate_2.gcode.3mf", "plate": 2, "print": True},
        }

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_second_upload_reuses_the_inbox(self, async_client: AsyncClient, db_session: AsyncSession):
        first = await async_client.post("/api/files/local", **_upload_form("a.gcode.3mf"))
        second = await async_client.post("/api/files/local", **_upload_form("b.gcode.3mf", plate=None, start="false"))
        assert first.status_code == 201 and second.status_code == 201

        db_session.expire_all()
        files = (
            (await db_session.execute(select(LibraryFile).where(LibraryFile.source_type == "orcaslicer")))
            .scalars()
            .all()
        )
        assert len(files) == 2
        assert files[0].folder_id == files[1].folder_id
        assert len((await db_session.execute(select(LibraryFolder))).scalars().all()) == 1
        b = next(f for f in files if f.filename == "b.gcode.3mf")
        assert b.file_metadata["slicer_upload"]["plate"] is None
        assert b.file_metadata["slicer_upload"]["print"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_plateindex_that_is_no_plate_is_ignored(self, async_client: AsyncClient, db_session: AsyncSession):
        response = await async_client.post("/api/files/local", **_upload_form(plate="abc"))
        assert response.status_code == 201
        assert (await _only_slicer_file(db_session)).file_metadata["slicer_upload"]["plate"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_uses_the_configured_folder(self, async_client: AsyncClient, db_session: AsyncSession):
        folder = LibraryFolder(name="From Orca", shared=True)
        db_session.add(folder)
        await db_session.commit()
        folder_id = folder.id
        db_session.add(Settings(key="slicer_inbox_folder_id", value=str(folder_id)))
        await db_session.commit()

        response = await async_client.post("/api/files/local", **_upload_form())
        assert response.status_code == 201
        assert (await _only_slicer_file(db_session)).folder_id == folder_id

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_deleted_configured_folder_falls_back(self, async_client: AsyncClient, db_session: AsyncSession):
        db_session.add(Settings(key="slicer_inbox_folder_id", value="9999"))
        await db_session.commit()

        response = await async_client.post("/api/files/local", **_upload_form())
        assert response.status_code == 201
        folder_id = (await _only_slicer_file(db_session)).folder_id
        assert await _setting(db_session, "slicer_inbox_folder_id") == str(folder_id)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_configured_folder_the_owner_cannot_write_is_refused(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        admin_token = await _setup_admin(async_client)
        headers = {"Authorization": f"Bearer {admin_token}"}
        group = await async_client.post(
            "/api/v1/groups/",
            headers=headers,
            json={"name": "orca_uploaders", "permissions": ["library:upload", "library:read_own"]},
        )
        assert group.status_code in (200, 201), group.text
        created = await async_client.post(
            "/api/v1/users/",
            headers=headers,
            json={"username": "uploader", "password": _PW, "role": "user", "group_ids": [group.json()["id"]]},
        )
        assert created.status_code in (200, 201), created.text
        admin = await _user(db_session, "orcaadmin")
        private = LibraryFolder(name="Admin only", shared=False, created_by_id=admin.id)
        db_session.add(private)
        await db_session.commit()
        db_session.add(Settings(key="slicer_inbox_folder_id", value=str(private.id)))
        await db_session.commit()
        key = await _make_key(db_session, await _user(db_session, "uploader"))

        response = await async_client.post("/api/files/local", headers={"X-Api-Key": key}, **_upload_form())
        assert response.status_code == 403
        assert "Admin only" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_refuses_what_is_not_a_gcode_3mf(self, async_client: AsyncClient, db_session: AsyncSession):
        response = await async_client.post(
            "/api/files/local",
            files={"file": ("Cube.gcode", b"; raw\nG28\n", "application/octet-stream")},
            data={"print": "false"},
        )
        assert response.status_code == 415
        assert "Use 3MF instead of G-code" in response.json()["detail"]
        db_session.expire_all()
        assert (await db_session.execute(select(LibraryFile))).scalars().all() == []

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_key_without_library_scope_cannot_upload(self, async_client: AsyncClient, db_session: AsyncSession):
        await _setup_admin(async_client)
        key = await _make_key(
            db_session, await _user(db_session, "orcaadmin"), can_manage_library=False, can_queue=True
        )
        response = await async_client.post("/api/files/local", headers={"X-Api-Key": key}, **_upload_form())
        assert response.status_code == 403
        db_session.expire_all()
        assert (await db_session.execute(select(LibraryFile))).scalars().all() == []


class TestPending:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_lists_the_upload_until_it_is_decided(self, async_client: AsyncClient, db_session: AsyncSession):
        admin_token = await _setup_admin(async_client)
        headers = {"Authorization": f"Bearer {admin_token}"}
        key = await _make_key(db_session, await _user(db_session, "orcaadmin"))
        assert (
            await async_client.post("/api/files/local", headers={"X-Api-Key": key}, **_upload_form())
        ).status_code == 201
        stored = await _only_slicer_file(db_session)

        pending = await async_client.get("/api/v1/slicer-inbox/pending", headers=headers)
        assert pending.status_code == 200, pending.text
        [entry] = pending.json()
        assert entry["id"] == stored.id
        assert entry["plate"] == 2
        assert entry["print"] is True
        assert entry["sliced_for_model"] == "P1S"
        assert entry["folder_id"] == stored.folder_id

        # Queued (or printed, which queues it): no longer waiting.
        item = PrintQueueItem(library_file_id=stored.id, status="pending", position=1)
        db_session.add(item)
        await db_session.commit()
        assert (await async_client.get("/api/v1/slicer-inbox/pending", headers=headers)).json() == []

        # Taken off the queue again, it waits once more.
        await db_session.delete(item)
        await db_session.commit()
        assert len((await async_client.get("/api/v1/slicer-inbox/pending", headers=headers)).json()) == 1

        # Kept in another folder: decided.
        elsewhere = LibraryFolder(name="Keep", shared=True)
        db_session.add(elsewhere)
        await db_session.commit()
        moved = await async_client.post(
            "/api/v1/library/files/move",
            headers=headers,
            json={"file_ids": [stored.id], "folder_id": elsewhere.id},
        )
        assert moved.status_code == 200, moved.text
        assert (await async_client.get("/api/v1/slicer-inbox/pending", headers=headers)).json() == []

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_a_discarded_upload_is_not_waiting(self, async_client: AsyncClient, db_session: AsyncSession):
        assert (await async_client.post("/api/files/local", **_upload_form())).status_code == 201
        stored = await _only_slicer_file(db_session)
        assert (await async_client.delete(f"/api/v1/library/files/{stored.id}")).status_code == 200
        assert (await _file(db_session, stored.id)).deleted_at is not None
        assert (await async_client.get("/api/v1/slicer-inbox/pending")).json() == []

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ordinary_files_in_the_inbox_are_not_listed(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        assert (await async_client.post("/api/files/local", **_upload_form())).status_code == 201
        stored = await _only_slicer_file(db_session)
        manual = await async_client.post(
            "/api/v1/library/files",
            params={"folder_id": stored.folder_id},
            files={"file": ("manual.gcode.3mf", _sliced_3mf(), "application/zip")},
        )
        assert manual.status_code == 200, manual.text
        assert [e["id"] for e in (await async_client.get("/api/v1/slicer-inbox/pending")).json()] == [stored.id]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_each_user_sees_only_their_own(self, async_client: AsyncClient, db_session: AsyncSession):
        admin_token = await _setup_admin(async_client)
        headers = {"Authorization": f"Bearer {admin_token}"}
        group = await async_client.post(
            "/api/v1/groups/",
            headers=headers,
            json={"name": "orca_readers", "permissions": ["library:upload", "library:read_own"]},
        )
        created = await async_client.post(
            "/api/v1/users/",
            headers=headers,
            json={"username": "other", "password": _PW, "role": "user", "group_ids": [group.json()["id"]]},
        )
        assert created.status_code in (200, 201), created.text
        key = await _make_key(db_session, await _user(db_session, "orcaadmin"))
        assert (
            await async_client.post("/api/files/local", headers={"X-Api-Key": key}, **_upload_form())
        ).status_code == 201

        login = await async_client.post("/api/v1/auth/login", json={"username": "other", "password": _PW})
        other_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        assert (await async_client.get("/api/v1/slicer-inbox/pending", headers=other_headers)).json() == []
        assert len((await async_client.get("/api/v1/slicer-inbox/pending", headers=headers)).json()) == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_needs_sign_in(self, async_client: AsyncClient):
        await _setup_admin(async_client)
        assert (await async_client.get("/api/v1/slicer-inbox/pending")).status_code == 401


class TestDeviceTabSession:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_session_wins_over_an_added_api_key(self, async_client: AsyncClient, db_session: AsyncSession):
        admin_token = await _setup_admin(async_client)
        key = await _make_key(db_session, await _user(db_session, "orcaadmin"))

        # The upload key alone may not read the printers...
        assert (await async_client.get("/api/v1/printers/", headers={"X-API-Key": key})).status_code == 403
        # ...but the signed-in user in OrcaSlicer's Device tab, whose fetches
        # carry the key too, is judged by their session.
        both = {"Authorization": f"Bearer {admin_token}", "X-API-Key": key}
        assert (await async_client.get("/api/v1/printers/", headers=both)).status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_an_invalid_session_does_not_fall_back_to_the_key(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        await _setup_admin(async_client)
        key = await _make_key(db_session, await _user(db_session, "orcaadmin"), can_read_status=True)
        both = {"Authorization": "Bearer not-a-jwt", "X-API-Key": key}
        assert (await async_client.get("/api/v1/printers/", headers=both)).status_code == 401
        assert (await async_client.get("/api/v1/printers/", headers={"X-API-Key": key})).status_code == 200
