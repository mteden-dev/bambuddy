"""Products made of printed parts, orders for them, and the jobs that print them (fork).

Fork-only tables, created by ``create_all`` like any model: the official image
has no model for them and never reads them, so going back to that image leaves
them behind untouched, and the queue jobs the planner made stay ordinary jobs.
See services/products.py and services/product_planner.py.
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, false, func, true
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class Product(Base):
    """Something made of several printed parts, such as a box: lid, base and tray."""

    __tablename__ = "custom_products"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # An uploaded picture, relative to the data dir; without one the product
    # shows its first plate's thumbnail.
    thumbnail_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    parts: Mapped[list["ProductPart"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="ProductPart.sort_order",
    )
    plates: Mapped[list["ProductPlate"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="ProductPlate.sort_order",
    )
    # Shop SKUs that are this product (models/base_sync.py). Deleting the
    # product deletes them, never turns them into "not printed".
    skus: Mapped[list["ProductSku"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ProductSku.sku",
    )


class ProductPart(Base):
    """One part of a product and how many of it one product takes.

    Parts marked ``matched`` should all come from the same printer for one
    product: every printer prints walls a little differently, so a lid and a
    base printed on two machines may not fit as well.
    """

    __tablename__ = "custom_product_parts"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("custom_products.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    matched: Mapped[bool] = mapped_column(Boolean, default=False)
    # Work on the piece after it is printed before the product is done, such
    # as a tray glued into the base drying for an hour: the planner prints
    # such parts earlier.
    finish_minutes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    product: Mapped["Product"] = relationship(back_populates="parts")


class ProductPlate(Base):
    """A sliced file (one plate of it) that prints pieces of a product's parts.

    The printer model is the file's own (``sliced_for_model``), so the same part
    usually has a plate per model, and per number of pieces: 1, 2, 3 on a P1S,
    more on an H2S. A plate may hold pieces of several parts.
    """

    __tablename__ = "custom_product_plates"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("custom_products.id", ondelete="CASCADE"), index=True)
    library_file_id: Mapped[int] = mapped_column(ForeignKey("library_files.id", ondelete="CASCADE"))
    # Plate index in a multi-plate file; None for a single-plate file.
    plate_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    product: Mapped["Product"] = relationship(back_populates="plates")
    library_file: Mapped["LibraryFile"] = relationship()
    pieces: Mapped[list["ProductPlatePart"]] = relationship(
        back_populates="plate",
        cascade="all, delete-orphan",
    )


class ProductPlatePart(Base):
    """How many pieces of one part a plate prints."""

    __tablename__ = "custom_product_plate_parts"

    plate_id: Mapped[int] = mapped_column(ForeignKey("custom_product_plates.id", ondelete="CASCADE"), primary_key=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("custom_product_parts.id", ondelete="CASCADE"), primary_key=True)
    pieces: Mapped[int] = mapped_column(Integer, default=1)

    plate: Mapped["ProductPlate"] = relationship(back_populates="pieces")


class ProductOrder(Base):
    """An order for some of a product.

    Open orders share the parts in stock in order (due date, then when they
    came in). An order is done once its parts are all there; ``consumed``
    then records which pieces it took (part id -> printer id -> pieces, both
    as strings, printer "0" for pieces of unknown origin), and they leave the
    stock.
    """

    __tablename__ = "custom_product_orders"
    __table_args__ = (Index("uq_custom_product_orders_external", "external_source", "external_ref", unique=True),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("custom_products.id", ondelete="CASCADE"), index=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    due_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # open, done, cancelled
    status: Mapped[str] = mapped_column(String(20), default="open")
    consumed: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # The record in another system (a shop) this order came from; both or neither.
    external_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    external_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ProductJob(Base):
    """A queue job the planner made for a product, and what it printed.

    ``pieces`` is a copy of the plate's pieces when the job was planned (part id
    as a string -> pieces), so editing the plate later does not change what a
    finished job counted. ``status`` follows the queue job: planned (waiting,
    the planner may replace it), printing, done, failed or cancelled. A done
    job's pieces are in stock on ``printer_id``, the printer that printed them,
    less the ones found bad when someone checked them (``rejected``, part id as
    a string -> pieces). Until ``checked_at`` its pieces count as good.

    Two kinds of waiting job are the user's, not the planner's, and a plan
    keeps them as they are: one queued by hand (``by_hand``: a plate's file
    printed from the library, the history or a printer card, linked when the
    planner finds it), and one moved by hand to another printer than the plan
    put it on (``planned_printer_id``). A moved job the orders no longer need
    still leaves the queue; one queued by hand never does.

    A finished job with bad pieces can be printed again from the check
    (``reprint_of_id`` on the new job, which counts as queued by hand).

    A job queued by hand counts only when the products settings say plates
    printed by hand count (``counted``); otherwise the planner prints the
    orders as if it were not there.
    """

    __tablename__ = "custom_product_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("custom_products.id", ondelete="CASCADE"), index=True)
    product_plate_id: Mapped[int | None] = mapped_column(
        ForeignKey("custom_product_plates.id", ondelete="SET NULL"), nullable=True
    )
    queue_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("print_queue.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # The queue job's created_at: SQLite gives a freed id to the next job, so a
    # job created at another moment is not this one.
    item_created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Planned printer, then the printer that took it. Plain ids: this is history.
    printer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    archive_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Pinned to its printer because it prints matched parts.
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    # The printer the plan put it on; a waiting job pinned or reserved elsewhere
    # was moved by hand. None for jobs from before it was kept (printer_id then).
    planned_printer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Queued by hand (a plate's file printed outside the planner), linked so its
    # pieces count; the planner never replaces or removes it.
    by_hand: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    # Its pieces count: in stock, as coming, for the orders. A plate printed by
    # hand while the products settings say such prints do not count is linked
    # (it shows, it can be checked) but counts for nothing, and its reprints
    # neither. Set when the job is linked; changing the setting later leaves
    # the jobs linked before as they are.
    counted: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    status: Mapped[str] = mapped_column(String(20), default="planned")
    pieces: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Someone looked at the finished pieces; rejected: part id (string) -> bad pieces.
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    rejected: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Queued from the check of this finished job, to print its plate again.
    reprint_of_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # The printer someone would rather it printed on: a nudge the next plans
    # weigh, not a pin. A plan that puts the plate elsewhere says why in
    # ``plan_info``, and the job that prints the plate next carries it on.
    preferred_printer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # What the plan worked out for it: the filament it takes and what is left
    # on the spools after it, and why it is not on the preferred printer.
    plan_info: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ProductStockAdjustment(Base):
    """A correction to the parts in stock: a bad piece thrown away, pieces found."""

    __tablename__ = "custom_product_stock"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("custom_product_parts.id", ondelete="CASCADE"), index=True)
    # The printer that made the pieces; None when unknown.
    printer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    delta: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


from backend.app.models.base_sync import ProductSku  # noqa: E402
from backend.app.models.library import LibraryFile  # noqa: E402
