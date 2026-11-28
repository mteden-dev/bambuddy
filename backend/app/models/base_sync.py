"""Orders read from Base (base.com, formerly BaseLinker) and the SKUs they name (fork).

Fork-only tables, created by ``create_all`` like any model: the official image
has no model for them and never reads them. See services/base_sync.py.

Of the buyer only the marketplace login is stored (an Allegro nick, to label
prints): an order keeps its Base id, its number in the shop or marketplace,
where it came from, its status, when it was confirmed, when it must ship and
its product lines (SKU, name, quantity).
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class ProductSku(Base):
    """A shop SKU and the product it is (``units`` of it), or a SKU nobody prints.

    ``product_id`` NULL marks a SKU that is not printed (stickers, bought-in
    items): order lines with it are left out without asking.
    """

    __tablename__ = "custom_product_skus"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    product_id: Mapped[int | None] = mapped_column(
        ForeignKey("custom_products.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Products one item of the SKU is, e.g. 3 for a set of three boxes.
    units: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class BaseOrder(Base):
    """An order the sync found in Base, and what Bambuddy did with it.

    ``state``: ``new`` waits for someone to send it to production (unless
    orders are accepted automatically), ``accepted`` has product orders,
    ``skipped`` was left out on purpose, ``cancelled`` was cancelled in Base.
    """

    __tablename__ = "custom_base_orders"

    # Base's order id.
    order_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    # The number the shop or marketplace shows (shop_order_id / external_order_id).
    number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The buyer's marketplace login (an Allegro nick): the label on its prints.
    # Nothing else about the buyer is kept.
    buyer_login: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # The marketplace's ship-by deadline (getOrderTransactionData's ship_date_to,
    # e.g. Allegro's), the due date of its product orders; None when it has none
    # (a shop order) or it was not read yet.
    ship_by: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    date_confirmed: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # [{"sku": ..., "name": ..., "quantity": n, "attributes": ...}]
    items: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(20), default="new")
    # product id (string) -> products of it not printed for this order (sent
    # from the shelf, made another way), chosen when it was sent to production.
    held: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # part id (string) -> pieces on hand put into stock for this order (so a
    # change puts in or takes out only the difference).
    on_hand: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # A choice saved on a waiting order before it is sent ({"held": {product:
    # n}, "on_hand": {part: n}}): nothing goes into stock or the queue until
    # it is sent, which applies it.
    draft: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # The lines someone has already for this order ("I have it": made by hand,
    # or a product not in Bambuddy yet), by key (services/base_sync.line_key):
    # nothing is printed for them, whatever their SKU maps to, and a line that
    # maps to no product no longer keeps the order from ready.
    have_lines: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # The last sync found it in one of the statuses orders are taken from.
    in_status: Mapped[bool] = mapped_column(Boolean, default=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
