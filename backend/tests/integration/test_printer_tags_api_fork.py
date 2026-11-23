"""Printer tags API (fork): printer tags and the tags a queued job asks for."""

import pytest
from httpx import AsyncClient

from backend.app.models.library import LibraryFile, LibraryFileTag, LibraryTag
from backend.app.models.queue_item_tags import QueueItemTagOverride


@pytest.fixture
async def tagged(db_session, printer_factory):
    """Two P1S printers, tags tray + left, a file tagged tray."""
    p1 = await printer_factory(name="P1S-1", model="P1S")
    p2 = await printer_factory(name="P1S-2", model="P1S")
    tray = LibraryTag(name="tray", name_key="tray")
    left = LibraryTag(name="left", name_key="left")
    lib = LibraryFile(
        filename="tray.gcode.3mf",
        file_path="/test/library/tray.gcode.3mf",
        file_size=10,
        file_type="gcode.3mf",
        file_metadata={"print_name": "Tray"},
    )
    db_session.add_all([tray, left, lib])
    await db_session.flush()
    db_session.add(LibraryFileTag(file_id=lib.id, tag_id=tray.id))
    await db_session.commit()
    return p1, p2, tray.id, left.id, lib.id


class TestPrinterTags:
    async def test_set_list_and_clear(self, async_client: AsyncClient, tagged):
        p1, p2, tray, left, _ = tagged
        put = await async_client.put(f"/api/v1/printer-tags/{p1.id}", json={"tag_ids": [tray], "exclusive": True})
        assert put.status_code == 200, put.text
        assert put.json() == {"printer_id": p1.id, "tag_ids": [tray], "exclusive": True}
        await async_client.put(f"/api/v1/printer-tags/{p2.id}", json={"tag_ids": [left, tray]})

        listed = (await async_client.get("/api/v1/printer-tags")).json()
        assert listed == [
            {"printer_id": p1.id, "tag_ids": [tray], "exclusive": True},
            {"printer_id": p2.id, "tag_ids": sorted([tray, left]), "exclusive": False},
        ]

        cleared = await async_client.put(f"/api/v1/printer-tags/{p1.id}", json={"tag_ids": [], "exclusive": True})
        assert cleared.json() == {"printer_id": p1.id, "tag_ids": [], "exclusive": False}
        assert [r["printer_id"] for r in (await async_client.get("/api/v1/printer-tags")).json()] == [p2.id]

    async def test_unknown_tag_and_printer_are_refused(self, async_client: AsyncClient, tagged):
        p1, *_ = tagged
        assert (await async_client.put(f"/api/v1/printer-tags/{p1.id}", json={"tag_ids": [999]})).status_code == 400
        assert (await async_client.put("/api/v1/printer-tags/999", json={"tag_ids": []})).status_code == 404


class TestQueueJobTags:
    async def test_a_job_asks_for_its_files_printer_tags(self, async_client: AsyncClient, tagged):
        p1, _, tray, _, lib = tagged
        await async_client.put(f"/api/v1/printer-tags/{p1.id}", json={"tag_ids": [tray]})
        job = await async_client.post("/api/v1/queue/", json={"target_model": "P1S", "library_file_id": lib})
        assert job.status_code == 200, job.text

        tags = (await async_client.get("/api/v1/printer-tags/queue")).json()
        assert tags == [{"queue_item_id": job.json()["id"], "tag_ids": [tray], "overridden": False}]

    async def test_the_print_dialogs_tags_are_stored_with_each_copy(
        self, async_client: AsyncClient, db_session, tagged
    ):
        _, _, _, left, lib = tagged
        job = await async_client.post(
            "/api/v1/queue/",
            json={"target_model": "P1S", "library_file_id": lib, "quantity": 2, "required_tag_ids": [left]},
        )
        assert job.status_code == 200, job.text

        tags = (await async_client.get("/api/v1/printer-tags/queue")).json()
        assert len(tags) == 2
        assert all(t["tag_ids"] == [left] and t["overridden"] for t in tags)
        row = await db_session.get(QueueItemTagOverride, job.json()["id"])
        assert row is not None and row.item_created_at is not None

    async def test_edit_replaces_and_null_hands_back_to_the_file(self, async_client: AsyncClient, tagged):
        p1, _, tray, left, lib = tagged
        await async_client.put(f"/api/v1/printer-tags/{p1.id}", json={"tag_ids": [tray, left]})
        item_id = (
            await async_client.post("/api/v1/queue/", json={"target_model": "P1S", "library_file_id": lib})
        ).json()["id"]

        edit = await async_client.patch(f"/api/v1/queue/{item_id}", json={"required_tag_ids": [left]})
        assert edit.status_code == 200, edit.text
        assert (await async_client.get("/api/v1/printer-tags/queue")).json() == [
            {"queue_item_id": item_id, "tag_ids": [left], "overridden": True}
        ]

        # A PATCH that leaves the field out keeps them.
        await async_client.patch(f"/api/v1/queue/{item_id}", json={"manual_start": True})
        assert (await async_client.get("/api/v1/printer-tags/queue")).json()[0]["tag_ids"] == [left]

        await async_client.patch(f"/api/v1/queue/{item_id}", json={"required_tag_ids": None})
        assert (await async_client.get("/api/v1/printer-tags/queue")).json() == [
            {"queue_item_id": item_id, "tag_ids": [tray], "overridden": False}
        ]

    async def test_unknown_tags_are_refused_before_anything_is_queued(self, async_client: AsyncClient, tagged):
        *_, lib = tagged
        response = await async_client.post(
            "/api/v1/queue/", json={"target_model": "P1S", "library_file_id": lib, "required_tag_ids": [999]}
        )
        assert response.status_code == 400
        assert (await async_client.get("/api/v1/queue/")).json() == []


class TestFileRoutingTags:
    async def test_only_tags_some_printer_carries(self, async_client: AsyncClient, db_session, tagged):
        p1, _, tray, left, lib = tagged
        db_session.add(LibraryFileTag(file_id=lib, tag_id=left))
        await db_session.commit()
        # No printer tagged yet: no file tag routes anything.
        assert (await async_client.get(f"/api/v1/printer-tags/files?file_id={lib}")).json() == []

        await async_client.put(f"/api/v1/printer-tags/{p1.id}", json={"tag_ids": [tray]})
        response = await async_client.get(f"/api/v1/printer-tags/files?file_id={lib}&file_id=999")
        assert response.json() == [{"file_id": lib, "tag_ids": [tray]}]
