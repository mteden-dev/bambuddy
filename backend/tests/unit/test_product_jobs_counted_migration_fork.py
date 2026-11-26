"""Plates printed by hand stop counting once, when ``custom_product_jobs.counted`` is added (fork).

Before the column, every plate's file queued by hand was linked and its pieces
went to stock, though they usually went into boxes the plan never knew of. The
setting that lets them count is off unless set, so the jobs linked before it
stop counting with the column; afterwards the column is left as it is.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.fixture
async def engine():
    import importlib
    import pkgutil

    import backend.app.models as models
    from backend.app.core.database import Base

    for module in pkgutil.iter_modules(models.__path__):
        importlib.import_module(f"{models.__name__}.{module.name}")

    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # As a database from before the column.
        await conn.execute(text("ALTER TABLE custom_product_jobs DROP COLUMN counted"))
        for job_id, by_hand in ((1, 0), (2, 1)):
            await conn.execute(
                text(
                    "INSERT INTO custom_product_jobs (id, product_id, pinned, by_hand, status, pieces) "
                    "VALUES (:id, 1, 0, :by_hand, 'done', '{}')"
                ),
                {"id": job_id, "by_hand": by_hand},
            )
    yield eng
    await eng.dispose()


async def _counted(engine) -> dict[int, bool]:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT id, counted FROM custom_product_jobs ORDER BY id"))
        return {job_id: bool(counted) for job_id, counted in rows}


@pytest.mark.asyncio
async def test_jobs_queued_by_hand_stop_counting_when_the_column_comes(engine):
    async with engine.begin() as conn:
        await run_migrations(conn)
    assert await _counted(engine) == {1: True, 2: False}


@pytest.mark.asyncio
async def test_afterwards_the_column_is_left_as_it_is(engine):
    async with engine.begin() as conn:
        await run_migrations(conn)
        # Linked with hand prints counting.
        await conn.execute(text("UPDATE custom_product_jobs SET counted = 1"))
    async with engine.begin() as conn:
        await run_migrations(conn)
    assert await _counted(engine) == {1: True, 2: True}
