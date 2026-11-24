/**
 * Fork (Base sync): orders read from Base, SKU mapping and the connection settings.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { BaseOrdersView } from '../../components/products/BaseOrdersView';
import type { BaseOrder, BaseSyncSettings } from '../../api/client';

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

const ORDER: BaseOrder = {
  order_id: 5001,
  number: '1243',
  source: 'allegro',
  source_name: 'Allegro Shop A',
  date_confirmed: '2026-11-24T09:00:00Z',
  ship_by: '2026-11-25T22:59:59Z',
  state: 'new',
  in_status: true,
  lines: [
    {
      sku: 'SKU-BOX-100-B',
      name: 'Box 9mm 100 Black',
      quantity: 2,
      attributes: 'Black',
      mapping: 'product',
      product_id: 4,
      product_name: '9mm 100 Black',
      units: 1,
    },
    {
      sku: 'SKU-STICKER-W',
      name: 'Stickers white',
      quantity: 1,
      attributes: '',
      mapping: 'unmapped',
      product_id: null,
      product_name: null,
      units: 1,
    },
  ],
  product_orders: [],
  ready: false,
  held: {},
  on_hand: {},
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
let accepted: { id: number; body: unknown }[];
let resets: number[];
let skipped: number[];
let mapped: { sku: string; body: unknown }[];
let saved: unknown[];

beforeEach(() => {
  settings = { ...SETTINGS };
  accepted = [];
  resets = [];
  skipped = [];
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
    http.get('/api/v1/base-sync/orders', () => HttpResponse.json([ORDER])),
    http.get('/api/v1/base-sync/skus', () =>
      HttpResponse.json({ mapped: [], unmapped: [{ sku: 'SKU-STICKER-W', name: 'Stickers white', orders: 1 }] }),
    ),
    http.get('/api/v1/products/', () => HttpResponse.json([{ id: 4, name: '9mm 100 Black', parts: [], plates: [], skus: [] }])),
    http.post('/api/v1/base-sync/orders/:id/accept', async ({ params, request }) => {
      const text = await request.text();
      accepted.push({ id: Number(params.id), body: text ? JSON.parse(text) : null });
      return HttpResponse.json({ ...ORDER, state: 'accepted' });
    }),
    http.get('/api/v1/products/:id', () => HttpResponse.json(PRODUCT)),
    http.post('/api/v1/base-sync/orders/:id/reset', ({ params }) => {
      resets.push(Number(params.id));
      return HttpResponse.json(ORDER);
    }),
    http.post('/api/v1/base-sync/orders/:id/skip', ({ params }) => {
      skipped.push(Number(params.id));
      return HttpResponse.json({ ...ORDER, state: 'skipped' });
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

  it('lists an order with its mapped and unmapped lines and sends it to production', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('#1243')).toBeInTheDocument();
    expect(screen.getByText('Allegro Shop A')).toBeInTheDocument();
    // The ship-by date: a coloured label near it, the date itself further off.
    expect(screen.queryByText(/^ship by /) ?? screen.getByTitle(/^ship by /)).toBeInTheDocument();
    // The line's product badge (the unmapped panel's product list has the name too).
    expect(screen.getAllByText('9mm 100 Black').some((el) => el.tagName === 'SPAN')).toBe(true);
    expect(screen.getAllByText('no product').length).toBeGreaterThan(0);
    // "Print all" sends the whole order at once, and can be taken back for a moment.
    await user.click(screen.getByRole('button', { name: 'Print all' }));
    await waitFor(() => expect(accepted).toEqual([{ id: 5001, body: null }]));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(resets).toEqual([5001]));
  });

  it('sends an order line by line: fewer boxes, a part on the shelf', async () => {
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Choose…' }));
    expect(await screen.findByRole('dialog', { name: 'Print order #1243' })).toBeInTheDocument();
    // One tap per count: segments, no keyboard.
    const toPrint = screen.getByRole('radiogroup', { name: 'How many of 9mm 100 Black to print' });
    expect(within(toPrint).getByRole('radio', { name: '2' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(toPrint).getByRole('radio', { name: '1' }));
    // Bambuddy counts one base in stock already; a lid is on the shelf.
    const lid = await screen.findByRole('radiogroup', { name: 'Extra Lid of 9mm 100 Black on hand' });
    await user.click(within(lid).getByRole('radio', { name: '1' }));
    expect(screen.getByText('Printing: 1 × 9mm 100 Black')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send to production' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() =>
      expect(accepted).toEqual([
        { id: 5001, body: { products: [{ product_id: 4, units: 1, have: [{ part_id: 41, pieces: 1 }] }] } },
      ]),
    );
  });

  it('changing an accepted order starts from what is on hand for it', async () => {
    server.use(
      http.get('/api/v1/base-sync/orders', () =>
        HttpResponse.json([{ ...ORDER, state: 'accepted', held: { '4': 1 }, on_hand: { '41': 1 } }]),
      ),
    );
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    expect(await screen.findByText('printing 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const lid = await screen.findByRole('radiogroup', { name: 'Extra Lid of 9mm 100 Black on hand' });
    expect(within(lid).getByRole('radio', { name: '1' })).toHaveAttribute('aria-checked', 'true');
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() =>
      expect(accepted).toEqual([
        { id: 5001, body: { products: [{ product_id: 4, units: 1, have: [{ part_id: 41, pieces: 1 }] }] } },
      ]),
    );
  });

  it('withdrawing an order from production asks first', async () => {
    server.use(http.get('/api/v1/base-sync/orders', () => HttpResponse.json([{ ...ORDER, state: 'accepted' }])));
    const user = userEvent.setup();
    render(<BaseOrdersView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Withdraw from production' }));
    expect(await screen.findByText('Withdraw order #1243?')).toBeInTheDocument();
    expect(skipped).toEqual([]);
    const buttons = screen.getAllByRole('button', { name: 'Withdraw from production' });
    await user.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(skipped).toEqual([5001]));
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
