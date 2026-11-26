/**
 * Fork (Base sync): orders read from Base, their parts, SKU mapping and the connection settings.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { BaseOrdersView } from '../../components/products/BaseOrdersView';
import type { BaseOrder, BaseSyncSettings, BaseWithdrawPreview } from '../../api/client';

const SETTINGS: BaseSyncSettings = {
  enabled: true,
  status_ids: [100001],
  cancel_status_id: 100002,
  sources: [],
  poll_minutes: 5,
  auto_accept: false,
  manual_start: false,
  handling_days: 0,
  since: null,
  token_set: true,
  last_run_at: null,
  last_ok_at: '2026-11-24T10:00:00Z',
  last_error: null,
};

function at(daysFromToday: number, hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  date.setHours(hour, 30, 0, 0);
  return date.toISOString();
}

const LINE = {
  sku: 'SKU-BOX-100-B',
  name: 'Box 9mm 100 Black',
  quantity: 2,
  attributes: 'Black',
  mapping: 'product' as const,
  product_id: 4,
  product_name: '9mm 100 Black',
  units: 1,
  has_thumbnail: true,
  thumbnail_version: 'v1',
};

const ORDER: BaseOrder = {
  order_id: 5001,
  number: 'f2c0a1d4-uuid',
  label: 'nick_5001',
  buyer_login: 'nick_5001',
  source: 'allegro',
  source_kind: 'allegro',
  source_name: 'Allegro Shop A',
  date_confirmed: '2026-11-24T09:00:00Z',
  ship_by: at(1, 23),
  state: 'new',
  in_status: true,
  lines: [
    LINE,
    {
      sku: 'SKU-STICKER-W',
      name: 'Stickers white',
      quantity: 1,
      attributes: '',
      mapping: 'unmapped',
      product_id: null,
      product_name: null,
      units: 1,
      has_thumbnail: false,
      thumbnail_version: null,
    },
  ],
  product_orders: [],
  ready: false,
  held: {},
  on_hand: {},
  draft: null,
  progress: [],
};

const SHOP_ORDER: BaseOrder = {
  ...ORDER,
  order_id: 5002,
  number: '1243',
  label: '#1243',
  buyer_login: null,
  source: 'shop',
  source_kind: 'shop',
  source_name: 'Sklep',
  ship_by: null,
  lines: [LINE],
};

const PRODUCT = {
  id: 4,
  name: '9mm 100 Black',
  notes: null,
  parts: [
    { id: 41, name: 'Lid', quantity: 1, matched: true, finish_minutes: 0 },
    { id: 42, name: 'Base', quantity: 1, matched: true, finish_minutes: 60 },
  ],
  plates: [],
  skus: [],
  stock: [{ part_id: 42, printer_id: 1, printer_name: 'P1S', pieces: 1 }],
  orders: [],
  jobs: [],
  unplanned: [],
};

let settings: BaseSyncSettings;
let orders: BaseOrder[];
let listUrls: string[];
let accepted: { id: number; body: unknown }[];
let drafts: { id: number; body: unknown }[];
let acceptReply: BaseOrder;
let resets: number[];
let skipped: number[];
let skipBodies: unknown[];
let previews: { return_done: boolean }[];
let preview: BaseWithdrawPreview;
const NO_CHANGE: BaseWithdrawPreview = { removed: [], added: [], printing: [], to_stock: [], done: [] };
let mapped: { sku: string; body: unknown }[];
let saved: unknown[];

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
  settings = { ...SETTINGS };
  orders = [ORDER];
  listUrls = [];
  accepted = [];
  drafts = [];
  acceptReply = { ...ORDER, state: 'accepted' };
  resets = [];
  skipped = [];
  skipBodies = [];
  previews = [];
  preview = NO_CHANGE;
  mapped = [];
  saved = [];
  server.use(
    http.get('/api/v1/base-sync/settings', () => HttpResponse.json(settings)),
    http.put('/api/v1/base-sync/settings', async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json(settings);
    }),
    http.post('/api/v1/base-sync/test', () =>
      HttpResponse.json({
        statuses: [
          { id: 100001, name: 'Przyjęte do realizacji', color: null },
          { id: 100011, name: 'DZIŚ', color: '#ff0000' },
          { id: 100012, name: 'Jutro', color: null },
          { id: 100002, name: 'Anulowane', color: null },
        ],
        sources: [{ key: 'allegro:1111', name: 'Allegro Shop A' }],
      }),
    ),
    http.get('/api/v1/base-sync/orders/counts', () =>
      HttpResponse.json({ new: { allegro: 1, shop: 1 }, accepted: { allegro: 0, shop: 0 } }),
    ),
    http.get('/api/v1/base-sync/orders', ({ request }) => {
      listUrls.push(request.url);
      const source = new URL(request.url).searchParams.get('source');
      return HttpResponse.json(source ? orders.filter((o) => o.source_kind === source) : orders);
    }),
    http.get('/api/v1/base-sync/skus', () =>
      HttpResponse.json({ mapped: [], unmapped: [{ sku: 'SKU-STICKER-W', name: 'Stickers white', orders: 1 }] }),
    ),
    http.get('/api/v1/products/', () => HttpResponse.json([{ ...PRODUCT, plates: [], skus: [] }])),
    http.get('/api/v1/products/:id', () => HttpResponse.json(PRODUCT)),
    http.post('/api/v1/base-sync/orders/:id/accept', async ({ params, request }) => {
      const text = await request.text();
      accepted.push({ id: Number(params.id), body: text ? JSON.parse(text) : null });
      return HttpResponse.json(acceptReply);
    }),
    http.post('/api/v1/base-sync/orders/:id/draft', async ({ params, request }) => {
      drafts.push({ id: Number(params.id), body: await request.json() });
      return HttpResponse.json(ORDER);
    }),
    http.post('/api/v1/base-sync/orders/:id/reset', ({ params }) => {
      resets.push(Number(params.id));
      return HttpResponse.json(ORDER);
    }),
    http.post('/api/v1/base-sync/orders/:id/skip', async ({ params, request }) => {
      skipped.push(Number(params.id));
      const text = await request.text();
      skipBodies.push(text ? JSON.parse(text) : null);
      return HttpResponse.json({ ...ORDER, state: 'skipped' });
    }),
    http.post('/api/v1/base-sync/orders/:id/skip/preview', async ({ request }) => {
      const body = (await request.json()) as { return_done: boolean };
      previews.push(body);
      return HttpResponse.json(preview);
    }),
    http.put('/api/v1/base-sync/skus/:sku', async ({ params, request }) => {
      mapped.push({ sku: String(params.sku), body: await request.json() });
      return HttpResponse.json({ sku: params.sku, product_id: null, product_name: null, units: 1 });
    }),
  );
});

const allowAll = () => true;

describe('BaseOrdersView', () => {
  it('asks to connect Base when it is not set up', async () => {
    settings = { ...SETTINGS, token_set: false, status_ids: [], enabled: false };
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByRole('button', { name: 'Connect Base' })).toBeInTheDocument();
  });

  it('shows an order by the buyer\'s nick with its lines, and prints it with undo', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('nick_5001')).toBeInTheDocument();
    // The long Allegro number is gone; the Base id is there.
    expect(screen.queryByText(/f2c0a1d4/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Base 5001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('9mm 100 Black').length).toBeGreaterThan(0);
    expect(screen.getAllByText('no product').length).toBeGreaterThan(0);
    expect(screen.getByText('tomorrow')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(accepted).toEqual([{ id: 5001, body: null }]));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(resets).toEqual([5001]));
  });

  it('printing an order opens the plates the plan chose, and its row opens them again', async () => {
    const opened: number[] = [];
    server.use(
      http.get('/api/v1/base-sync/orders/:id/plates', ({ params }) => {
        opened.push(Number(params.id));
        return HttpResponse.json([]);
      }),
    );
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Planned plates' });
    await waitFor(() => expect(opened).toEqual([5001]));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Planned plates' })).not.toBeInTheDocument();

    orders = [{ ...ORDER, state: 'accepted' }];
    await user.click(screen.getByRole('button', { name: 'In production' }));
    await user.click(await screen.findByRole('button', { name: 'Plates' }));
    expect(await screen.findByRole('dialog', { name: 'Planned plates' })).toBeInTheDocument();
  });

  it('a ready order has no plates to open', async () => {
    orders = [{ ...ORDER, state: 'accepted', ready: true }];
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('nick_5001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plates' })).not.toBeInTheDocument();
  });

  it('lists Allegro by ship-by date, then the shop, under section headers', async () => {
    orders = [{ ...ORDER, order_id: 5003, label: 'nick_today', ship_by: at(0, 23) }, ORDER, SHOP_ORDER];
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('#1243')).toBeInTheDocument();
    const headers = screen.getAllByRole('heading', { level: 3 });
    const texts = headers.map((h) => h.textContent);
    const today = texts.indexOf('Today · 1');
    const tomorrow = texts.indexOf('Tomorrow · 1');
    const shop = texts.indexOf('Shop · oldest first · 1');
    expect(today).toBeGreaterThan(-1);
    expect(tomorrow).toBeGreaterThan(today);
    expect(shop).toBeGreaterThan(tomorrow);
  });

  it('filters by source and searches', async () => {
    orders = [ORDER, SHOP_ORDER];
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('#1243')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Shop/ }));
    await waitFor(() => expect(listUrls.some((u) => u.includes('source=shop'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('nick_5001')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'All sources' }));
    await user.type(await screen.findByRole('searchbox'), 'nick_50');
    await waitFor(() => expect(screen.queryByText('#1243')).not.toBeInTheDocument());
    expect(screen.getByText('nick_5001')).toBeInTheDocument();
  });

  it('a waiting order keeps "I have the base" as a draft until it is printed', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Parts' }));
    const base = await screen.findByRole('radiogroup', { name: 'Extra Base of 9mm 100 Black on hand' });
    // What is there is the opposite of printing: its picked 0 is not the green "print" fill.
    expect(within(base).getByRole('radio', { name: '0' })).not.toHaveClass('bg-bambu-green');
    expect(screen.getByText('9mm 100 Black: 2 to print')).toBeInTheDocument();
    expect(screen.getByText('Base: 2 to print')).toBeInTheDocument();
    // Bambuddy's own stock is said only where there is some.
    expect(screen.getAllByText(/in stock/)).toHaveLength(1);
    await user.click(within(base).getByRole('radio', { name: '1' }));
    expect(within(base).getByRole('radio', { name: '1' })).toHaveClass('bg-sky-600');
    // Each part says what is left to print.
    expect(screen.getByText('Base: 1 to print')).toBeInTheDocument();
    expect(screen.getByText('Lid: 2 to print')).toBeInTheDocument();
    // Saved by itself, without sending anything to print.
    await waitFor(() =>
      expect(drafts).toEqual([
        { id: 5001, body: { products: [{ product_id: 4, units: 2, have: [{ part_id: 42, pieces: 1 }] }] } },
      ]),
    );
    expect(accepted).toEqual([]);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('"I have the whole product" counts what is there, and the parts go away', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Parts' }));
    const whole = await screen.findByRole('radiogroup', { name: 'Finished 9mm 100 Black on hand' });
    // Nothing is there yet: both are printed.
    expect(within(whole).getByRole('radio', { name: '0' })).toBeChecked();
    await user.click(within(whole).getByRole('radio', { name: '1' }));
    // One is there: the parts are for the one that is left.
    expect(screen.getByText('9mm 100 Black: 1 to print')).toBeInTheDocument();
    expect(screen.getByText('Lid: 1 to print')).toBeInTheDocument();
    await user.click(within(whole).getByRole('radio', { name: '2' }));
    expect(screen.getByText('You have the finished product – nothing to print.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Extra Lid of 9mm 100 Black on hand' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(drafts).toEqual([{ id: 5001, body: { products: [{ product_id: 4, units: 0, have: [] }] } }]),
    );
    // "Clear choices" prints everything again.
    await user.click(screen.getByRole('button', { name: 'Clear choices' }));
    expect(screen.getByText('Lid: 2 to print')).toBeInTheDocument();
    await waitFor(() => expect(drafts).toHaveLength(2));
    expect(drafts[1].body).toEqual({ products: [{ product_id: 4, units: 2, have: [] }] });
  });

  it('every part there says nothing is printed', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Parts' }));
    const base = await screen.findByRole('radiogroup', { name: 'Extra Base of 9mm 100 Black on hand' });
    const lid = screen.getByRole('radiogroup', { name: 'Extra Lid of 9mm 100 Black on hand' });
    await user.click(within(base).getByRole('radio', { name: '2' }));
    await user.click(within(lid).getByRole('radio', { name: '2' }));
    expect(screen.getByText('You have every part – nothing to print.')).toBeInTheDocument();
  });

  it('a big order steps the count and takes "all" in one tap', async () => {
    orders = [{ ...ORDER, lines: [{ ...LINE, quantity: 10 }] }];
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Parts' }));
    const base = await screen.findByRole('group', { name: 'Extra Base of 9mm 100 Black on hand' });
    await user.click(within(base.parentElement as HTMLElement).getByRole('button', { name: 'all' }));
    expect(screen.getByText('Base: 0 to print')).toBeInTheDocument();
    await waitFor(() =>
      expect(drafts).toEqual([
        { id: 5001, body: { products: [{ product_id: 4, units: 10, have: [{ part_id: 42, pieces: 10 }] }] } },
      ]),
    );
  });

  it('a draft shows on the row and "Print the rest" sends it', async () => {
    orders = [{ ...ORDER, draft: { held: {}, on_hand: { '42': 1 }, nothing_to_print: false } }];
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('Have: Base 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Print the rest' }));
    await waitFor(() => expect(accepted).toEqual([{ id: 5001, body: null }]));
  });

  it('a draft that leaves nothing to print marks the order ready instead', async () => {
    orders = [{ ...ORDER, draft: { held: { '7': 1 }, on_hand: {}, nothing_to_print: true } }];
    acceptReply = { ...ORDER, state: 'accepted', ready: true };
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await screen.findByText('nick_5001');
    expect(screen.queryByRole('button', { name: 'Print the rest' })).not.toBeInTheDocument();
    // The row says so before anything is opened.
    expect(screen.getByText('Have everything – nothing to print')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as ready' }));
    await waitFor(() => expect(accepted).toEqual([{ id: 5001, body: null }]));
    expect(await screen.findByText('The order is ready.')).toBeInTheDocument();
  });

  it('ready orders have their own tab, apart from production', async () => {
    orders = [{ ...ORDER, state: 'accepted', ready: true, held: { '4': 2 } }];
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: /^Ready/ }));
    await waitFor(() => expect(listUrls.some((u) => u.includes('state=ready'))).toBe(true));
    // Ready, not "to pack"; a product had in full is not a warning.
    expect(await screen.findByText('Ready', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('have it ready')).toBeInTheDocument();
    expect(screen.queryByText(/to pack/)).not.toBeInTheDocument();
  });

  it('orders packed in Base come after the ready ones, as packed, with nothing to do on them', async () => {
    orders = [
      { ...ORDER, state: 'accepted', ready: true, held: { '4': 2 } },
      { ...SHOP_ORDER, state: 'accepted', ready: true, in_status: false, packed: true },
      { ...ORDER, order_id: 5003, label: 'nick_5003', state: 'new', in_status: false, packed: true },
    ];
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: /^Ready/ }));
    const header = await screen.findByRole('heading', { name: /^Packed · 2/ });
    // The ready one first, without a header; the packed ones under theirs.
    const list = header.closest('section')!;
    expect(within(list).getByText('#1243')).toBeInTheDocument();
    expect(within(list).getByText('nick_5003')).toBeInTheDocument();
    expect(within(list).queryByText('nick_5001')).not.toBeInTheDocument();
    expect(within(list).getAllByText('Packed', { selector: 'span' })).toHaveLength(2);
    // Nothing to send or skip on a packed order.
    expect(within(list).queryByRole('button', { name: /Print|Skip|Parts/ })).not.toBeInTheDocument();
    expect(screen.getByText('nick_5001')).toBeInTheDocument();
  });

  it('an order in production shows its parts and changes apply at once', async () => {
    orders = [
      {
        ...ORDER,
        state: 'accepted',
        progress: [
          {
            product_id: 4,
            product_order_id: 9,
            status: 'open',
            units: 2,
            units_ready: 0,
            estimated_ready_at: null,
            parts: [
              { part_id: 41, name: 'Lid', ready: 0, needed: 2, on_hand: 0 },
              { part_id: 42, name: 'Base', ready: 2, needed: 2, on_hand: 0 },
            ],
          },
        ],
      },
    ];
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText(/Lid 0\/2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Parts' }));
    const lid = await screen.findByRole('radiogroup', { name: 'Extra Lid of 9mm 100 Black on hand' });
    await user.click(within(lid).getByRole('radio', { name: '1' }));
    await waitFor(() =>
      expect(accepted).toEqual([
        { id: 5001, body: { products: [{ product_id: 4, units: 2, have: [{ part_id: 41, pieces: 1 }] }] } },
      ]),
    );
    // Taking it out of production asks first.
    await user.click(screen.getByRole('button', { name: 'Withdraw from production' }));
    expect(await screen.findByText('Withdraw order nick_5001?')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Withdraw from production' });
    await user.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(skipped).toEqual([5001]));
  });

  it('an order whose print left the queue says so and is sent again', async () => {
    const progress = {
      product_id: 4,
      product_order_id: 9,
      status: 'open',
      units: 1,
      units_ready: 0,
      estimated_ready_at: null,
      parts: [
        { part_id: 41, name: 'Lid', ready: 0, needed: 1, on_hand: 0, missing: 1 },
        { part_id: 42, name: 'Base', ready: 0, needed: 1, on_hand: 0, missing: 0 },
      ],
    };
    orders = [{ ...ORDER, state: 'accepted', progress: [progress] }];
    const requeued: number[] = [];
    server.use(
      http.post('/api/v1/base-sync/orders/:id/requeue', ({ params }) => {
        requeued.push(Number(params.id));
        const parts = progress.parts.map((part) => ({ ...part, missing: 0 }));
        return HttpResponse.json({ ...orders[0], progress: [{ ...progress, parts }] });
      }),
    );
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('Not in the queue: Lid ×1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(requeued).toEqual([5001]));
    expect(await screen.findByText('Its prints are back in the queue.')).toBeInTheDocument();
  });

  it('an order with every print in the queue offers no Send again', async () => {
    orders = [
      {
        ...ORDER,
        state: 'accepted',
        progress: [
          {
            product_id: 4,
            product_order_id: 9,
            status: 'open',
            units: 1,
            units_ready: 0,
            estimated_ready_at: null,
            parts: [{ part_id: 41, name: 'Lid', ready: 0, needed: 1, on_hand: 0, missing: 0 }],
          },
        ],
      },
    ];
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText(/Lid 0\/1/)).toBeInTheDocument();
    expect(screen.queryByText(/Not in the queue/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send again' })).not.toBeInTheDocument();
  });

  it('withdrawing says first what leaves the queue and what goes to stock, then can be undone', async () => {
    orders = [{ ...ORDER, state: 'accepted' }];
    preview = {
      removed: [
        {
          queue_item_id: 31,
          filename: 'lid_x2.gcode.3mf',
          printer_name: 'P1S-A',
          pieces: [{ part_id: 41, name: 'Lid', pieces: 2 }],
        },
      ],
      added: [
        {
          queue_item_id: 40,
          filename: 'lid_x1.gcode.3mf',
          printer_name: 'P1S-A',
          pieces: [{ part_id: 41, name: 'Lid', pieces: 1 }],
        },
      ],
      printing: [
        {
          queue_item_id: 30,
          filename: 'base_x2.gcode.3mf',
          printer_name: 'P1S-B',
          pieces: [{ part_id: 42, name: 'Base', pieces: 2 }],
        },
      ],
      to_stock: [{ part_id: 42, name: 'Base', pieces: 1 }],
      done: [],
    };
    const accepts = accepted;
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Parts' }));
    await user.click(screen.getByRole('button', { name: 'Withdraw from production' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw order nick_5001?' });
    expect(await within(dialog).findByText('lid_x2')).toBeInTheDocument();
    expect(within(dialog).getByText('Leave the queue')).toBeInTheDocument();
    expect(within(dialog).getByText('lid_x1')).toBeInTheDocument();
    expect(within(dialog).getByText('base_x2')).toBeInTheDocument();
    expect(within(dialog).getByText('Into stock, for no order: Base ×1')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw from production' }));
    await waitFor(() => expect(skipped).toEqual([5001]));
    expect(skipBodies).toEqual([{ return_done: false }]);
    // Undo sends it again as it was.
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(accepts).toEqual([{ id: 5001, body: null }]));
    expect(await screen.findByText('The order is back in production.')).toBeInTheDocument();
  });

  it('withdrawing a ready order asks whether its boxes go back to stock', async () => {
    orders = [{ ...ORDER, state: 'accepted', ready: true }];
    preview = {
      ...NO_CHANGE,
      to_stock: [{ part_id: 41, name: 'Lid', pieces: 2 }],
      done: [{ product_id: 4, name: '9mm 100 Black', units: 2 }],
    };
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Parts' }));
    await user.click(screen.getByRole('button', { name: 'Withdraw from production' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw order nick_5001?' });
    const box = await within(dialog).findByRole('checkbox', { name: /Put what is done for it back in stock: 2× 9mm 100 Black/ });
    expect(box).toBeChecked();
    expect(previews).toEqual([{ return_done: true }]);
    // Unticked: asked again without (the boxes then stay with it), and withdrawn without.
    preview = { ...preview, to_stock: [] };
    await user.click(box);
    await waitFor(() => expect(previews).toEqual([{ return_done: true }, { return_done: false }]));
    await waitFor(() => expect(within(dialog).queryByText(/Into stock/)).toBeNull());
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw from production' }));
    await waitFor(() => expect(skipBodies).toEqual([{ return_done: false }]));
  });

  it('a failed load says so and can try again', async () => {
    server.use(http.get('/api/v1/base-sync/orders', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('Could not load the orders.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('maps an unmapped SKU to a product or marks it not printed', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    const select = await screen.findByLabelText('Product for SKU-STICKER-W');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, '4');
    await user.click(screen.getByRole('button', { name: 'Map' }));
    await user.click(screen.getByRole('button', { name: 'Not printed' }));
    await waitFor(() =>
      expect(mapped).toEqual([
        { sku: 'SKU-STICKER-W', body: { product_id: 4, units: 1 } },
        { sku: 'SKU-STICKER-W', body: { product_id: null, units: 1 } },
      ]),
    );
  });

  it('saves the connection settings with the chosen statuses', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Base settings' }));
    expect(await screen.findByRole('checkbox', { name: 'Przyjęte do realizacji' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'DZIŚ' }));
    await user.click(screen.getByRole('checkbox', { name: 'Jutro' }));
    await user.click(screen.getByLabelText(/Send new orders to production at once/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      status_ids: [100001, 100011, 100012],
      cancel_status_id: 100002,
      auto_accept: true,
      enabled: true,
    });
    expect(saved[0]).not.toHaveProperty('api_token');
    // No date stored and none entered: every order Base returns.
    expect(saved[0]).toMatchObject({ clear_since: true });
  });

  it('leaves out a status that is unticked', async () => {
    settings = { ...SETTINGS, status_ids: [100001, 100011] };
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Base settings' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Przyjęte do realizacji' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ status_ids: [100011] });
  });

  it('starts a new setup from now on', async () => {
    settings = { ...SETTINGS, status_ids: [], cancel_status_id: null, enabled: false };
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Base settings' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Przyjęte do realizacji' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const body = saved[0] as { since?: string; clear_since?: boolean };
    expect(body.clear_since).toBeUndefined();
    expect(Math.abs(Date.now() - new Date(body.since ?? 0).getTime())).toBeLessThan(120_000);
  });
});
