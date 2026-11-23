"""Printer tags: which printers an "Any <model>" job may run on (fork).

A printer carries tags from the library's tag catalog, the same tags files get
in File Manager. A job asks for tags:

* the ones it was given in the print dialog (QueueItemTagOverride), or else
* its library file's tags that some printer carries, read at every queue pass,
  so tagging files also routes the jobs already waiting for them. A file tag no
  printer has ("toy", "kid-safe") only sorts files and asks nothing of a
  printer.

A printer takes a job when it has every tag the job asks for. A printer set to
take only tagged jobs (``exclusive``) also refuses a job that asks for none of
its tags, so a printer kept for trays prints nothing but trays.

Only jobs for any printer of a model are routed. A job sent to one printer went
where the user put it.

Printer tags live in one settings row (``printer_tags``), which the official
image ignores.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from sqlalchemy import inspect as sa_inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.db_dialect import upsert_setting
from backend.app.core.printer_scope import ALL_PRINTERS, PrinterScope
from backend.app.models.library import LibraryFileTag, LibraryTag
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.queue_item_tags import QueueItemTagOverride
from backend.app.models.settings import Settings

PRINTER_TAGS_KEY = "printer_tags"

# What placement_refusal-style callers get back when tags refuse a printer.
REFUSAL_CODE = "tags"


@dataclass(frozen=True)
class PrinterTags:
    """One printer's tags, and whether it takes only jobs asking for one of them."""

    tag_ids: frozenset[int] = frozenset()
    exclusive: bool = False

    def accepts(self, wanted: frozenset[int]) -> bool:
        if not wanted <= self.tag_ids:
            return False
        # Exclusive only means something with tags to be exclusive about.
        return not (self.exclusive and self.tag_ids and not wanted & self.tag_ids)


NO_TAGS = PrinterTags()


def _int_ids(values: object) -> frozenset[int]:
    if not isinstance(values, list):
        return frozenset()
    return frozenset(v for v in values if isinstance(v, int) and not isinstance(v, bool))


def _parse(raw: str | None) -> dict[int, PrinterTags]:
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    parsed: dict[int, PrinterTags] = {}
    for key, value in data.items():
        try:
            printer_id = int(key)
        except (TypeError, ValueError):
            continue
        if isinstance(value, dict):
            parsed[printer_id] = PrinterTags(_int_ids(value.get("tag_ids")), bool(value.get("exclusive")))
    return parsed


async def tag_names(db: AsyncSession) -> dict[int, str]:
    """Every tag in the catalog, id to name."""
    rows = (await db.execute(select(LibraryTag.id, LibraryTag.name))).all()
    return {int(tag_id): str(name) for tag_id, name in rows}


async def read_printer_tags(db: AsyncSession, names: dict[int, str] | None = None) -> dict[int, PrinterTags]:
    """Each tagged printer's tags. A tag deleted from the catalog is dropped."""
    raw = (await db.execute(select(Settings.value).where(Settings.key == PRINTER_TAGS_KEY))).scalar()
    parsed = _parse(raw)
    if not parsed:
        return {}
    known = (names if names is not None else await tag_names(db)).keys()
    return {
        printer_id: PrinterTags(frozenset(t for t in tags.tag_ids if t in known), tags.exclusive)
        for printer_id, tags in parsed.items()
    }


async def write_printer_tags(db: AsyncSession, printer_id: int, tag_ids: Iterable[int], exclusive: bool) -> PrinterTags:
    """Store one printer's tags. The caller checks the ids and commits."""
    raw = (await db.execute(select(Settings.value).where(Settings.key == PRINTER_TAGS_KEY))).scalar()
    existing = set((await db.execute(select(Printer.id))).scalars().all())
    stored = {pid: tags for pid, tags in _parse(raw).items() if pid in existing and pid != printer_id}
    ids = frozenset(tag_ids)
    tags = PrinterTags(ids, bool(exclusive) and bool(ids))
    if ids:
        stored[printer_id] = tags
    value = {str(pid): {"tag_ids": sorted(t.tag_ids), "exclusive": t.exclusive} for pid, t in sorted(stored.items())}
    await upsert_setting(db, Settings, PRINTER_TAGS_KEY, json.dumps(value, separators=(",", ":")))
    return tags


def _created_at(item: PrintQueueItem):
    """``item.created_at`` if loaded, else None: an async session cannot load it on access."""
    return None if "created_at" in sa_inspect(item).unloaded else item.created_at


def _item_file_ids(item: PrintQueueItem) -> set[int]:
    """The library files a job prints from: its own, and each alternative's (#671)."""
    ids = {item.library_file_id} if item.library_file_id else set()
    # Never lazy-load here: the scheduler and the routes load variants with the
    # item, and an async session cannot load them on attribute access.
    if "variants" not in sa_inspect(item).unloaded:
        ids |= {v.library_file_id for v in item.variants if v.library_file_id}
    return ids


async def read_overrides(db: AsyncSession, items: Iterable[PrintQueueItem]) -> dict[int, frozenset[int]]:
    """The tags given by hand to each of ``items`` that has them."""
    by_id = {item.id: item for item in items if item.id is not None}
    if not by_id:
        return {}
    rows = (
        (await db.execute(select(QueueItemTagOverride).where(QueueItemTagOverride.queue_item_id.in_(by_id))))
        .scalars()
        .all()
    )
    overrides: dict[int, frozenset[int]] = {}
    for row in rows:
        created_at = _created_at(by_id[row.queue_item_id])
        if row.item_created_at is not None and created_at is not None and row.item_created_at != created_at:
            continue  # left by a deleted job whose id this one was given
        overrides[row.queue_item_id] = _int_ids(row.tag_ids)
    return overrides


async def set_override(db: AsyncSession, item: PrintQueueItem, tag_ids: Iterable[int] | None) -> None:
    """Give ``item`` these tags by hand, or (None) hand it back to its file's.

    ``item`` must be flushed. The caller commits, in the transaction that
    creates or edits the job, so no queue pass sees the job without them.
    """
    existing = await db.get(QueueItemTagOverride, item.id)
    if tag_ids is None:
        if existing is not None:
            await db.delete(existing)
        return
    if _created_at(item) is None:
        # A server default, not loaded back by the INSERT.
        await db.refresh(item, ["created_at"])
    ids = sorted(set(tag_ids))
    if existing is None:
        db.add(QueueItemTagOverride(queue_item_id=item.id, tag_ids=ids, item_created_at=item.created_at))
    else:
        existing.tag_ids = ids
        existing.item_created_at = item.created_at


async def check_tag_ids(db: AsyncSession, tag_ids: Iterable[int]) -> list[int]:
    """The ids not in the catalog."""
    wanted = set(tag_ids)
    if not wanted:
        return []
    found = set((await db.execute(select(LibraryTag.id).where(LibraryTag.id.in_(wanted)))).scalars().all())
    return sorted(wanted - found)


async def printer_queue_filter(
    db: AsyncSession, items: Iterable[PrintQueueItem]
) -> Callable[[PrintQueueItem, int], bool]:
    """Whether a job belongs in one printer's own queue list (card, "Next in queue").

    That list holds the printer's jobs and every "Any <model>" job for its
    model. One whose tags that printer refuses never runs there, so it is left
    out, as the scheduler and the queue timeline leave it out; so is one the
    timeline's plan holds for another printer, and it shows on that one's.
    """
    from backend.app.services.queue_reservations import QueueReservations

    unassigned = [item for item in items if item.printer_id is None]
    routing = await TagRouting.load(db, unassigned) if unassigned else TagRouting()
    reservations = await QueueReservations.load(db, unassigned) if unassigned else QueueReservations()

    def allows(item: PrintQueueItem, printer_id: int) -> bool:
        if item.printer_id is not None:
            return True
        reserved_for = reservations.active_printer(item, routing.scope(item))
        if reserved_for is not None:
            return reserved_for == printer_id
        return routing.accepts(item, printer_id)

    return allows


@dataclass
class TagRouting:
    """Everything a queue pass needs to route jobs by tags, read once."""

    printers: dict[int, PrinterTags] = field(default_factory=dict)
    printer_ids: frozenset[int] = frozenset()
    names: dict[int, str] = field(default_factory=dict)
    overrides: dict[int, frozenset[int]] = field(default_factory=dict)
    file_tags: dict[int, frozenset[int]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.used: frozenset[int] = frozenset().union(*(t.tag_ids for t in self.printers.values()))
        self.has_exclusive = any(t.exclusive and t.tag_ids for t in self.printers.values())

    @classmethod
    async def load(cls, db: AsyncSession, items: Iterable[PrintQueueItem]) -> TagRouting:
        items = list(items)
        names = await tag_names(db)
        printers = await read_printer_tags(db, names)
        overrides = await read_overrides(db, items)
        file_ids = set().union(*(_item_file_ids(i) for i in items if i.id not in overrides))
        file_tags: dict[int, set[int]] = {}
        if file_ids:
            rows = await db.execute(
                select(LibraryFileTag.file_id, LibraryFileTag.tag_id).where(LibraryFileTag.file_id.in_(file_ids))
            )
            for file_id, tag_id in rows.all():
                file_tags.setdefault(file_id, set()).add(tag_id)
        printer_ids = frozenset((await db.execute(select(Printer.id))).scalars().all())
        return cls(
            printers=printers,
            printer_ids=printer_ids,
            names=names,
            overrides=overrides,
            file_tags={fid: frozenset(tags) for fid, tags in file_tags.items()},
        )

    def is_overridden(self, item: PrintQueueItem) -> bool:
        return item.id in self.overrides

    def wanted(self, item: PrintQueueItem) -> frozenset[int]:
        """The tags ``item`` asks of a printer."""
        if item.id in self.overrides:
            return frozenset(t for t in self.overrides[item.id] if t in self.names)
        tags: set[int] = set()
        for file_id in _item_file_ids(item):
            tags |= self.file_tags.get(file_id, frozenset())
        return frozenset(tags) & self.used

    def accepts(self, item: PrintQueueItem, printer_id: int) -> bool:
        return self.printers.get(printer_id, NO_TAGS).accepts(self.wanted(item))

    def scope(self, item: PrintQueueItem) -> PrinterScope:
        """The printers ``item`` may run on, to intersect with its creator's scope."""
        wanted = self.wanted(item)
        if not wanted and not self.has_exclusive:
            return ALL_PRINTERS
        return PrinterScope(
            frozenset(pid for pid in self.printer_ids if self.printers.get(pid, NO_TAGS).accepts(wanted))
        )

    def label(self, tag_ids: Iterable[int]) -> str:
        return ", ".join(sorted((self.names.get(t, f"#{t}") for t in tag_ids), key=str.lower))

    def refusal(self, item: PrintQueueItem, printer_id: int) -> dict[str, str] | None:
        """Why tags keep ``item`` off ``printer_id``, or None when they don't."""
        printer = self.printers.get(printer_id, NO_TAGS)
        wanted = self.wanted(item)
        if printer.accepts(wanted):
            return None
        missing = wanted - printer.tag_ids
        if missing:
            return {"code": REFUSAL_CODE, "detail": f"The printer has no printer tag {self.label(missing)}"}
        return {
            "code": REFUSAL_CODE,
            "detail": f"The printer only takes jobs tagged {self.label(printer.tag_ids)}",
        }

    def wait_reason(self, item: PrintQueueItem, model: str) -> str:
        """The waiting reason of a job whose tags leave it no printer of ``model``."""
        wanted = self.wanted(item)
        if wanted:
            return (
                f"No {model} printer has the printer tags {self.label(wanted)} — tag a printer or edit the job's tags"
            )
        return f"Every {model} printer only takes jobs with its printer tags — give the job one of them"
