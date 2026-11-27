/**
 * Fork (products): the Products page.
 *
 * A product shows its parts; opening it shows its orders, queued jobs and
 * stock; ordering posts the order and reports the plan.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProductsView } from '../../components/products/ProductsView';
import type { ProductDetail, ProductPlanResult } from '../../api/client';

const PRODUCT = {
  id: 4,
  name: '9mm box',
  notes: null,
  parts: [
    { id: 1, name: 'Lid', quantity: 1, matched: true, finish_minutes: 0 },
    { id: 2, name: 'Base', quantity: 1, matched: true, finish_minutes: 60 },
    { id: 3, name: 'Tray', quantity: 1, matched: false, finish_minutes: 60 },
  ],
  plates: [
    {
      id: 10,
      library_file_id: 100,
      plate_id: null,
      pieces: [{ part_id: 1, pieces: 2 }],
      file: {
        library_file_id: 100,
        filename: 'lid_x2.gcode.3mf',
        print_name: null,
        model: 'P1S',
        print_time_seconds: 7200,
        filament_grams: 30,
        object_count: 2,
        has_thumbnail: false,
        missing: false,
      },
    },
  ],
  skus: [{ sku: 'SKU-BOX-100-B', units: 1 }],
  open_orders: 1,
  open_units: 2,
  has_thumbnail: true,
  custom_thumbnail: true,
  thumbnail_version: 'abc',
  created_at: '2026-11-24T08:00:00Z',
};

const DETAIL: ProductDetail = {
  ...PRODUCT,
  stock: [{ part_id: 3, printer_id: 7, printer_name: 'P1S-A', pieces: 1 }],
  orders: [
    {
      id: 20,
      quantity: 2,
      due_date: null,
      notes: 'shop #12',
      status: 'open',
      created_at: '2026-11-24T08:00:00Z',
      completed_at: null,
      units_ready: 0,
      parts: [
        { part_id: 1, ready: 0, needed: 2 },
        { part_id: 2, ready: 0, needed: 2 },
        { part_id: 3, ready: 1, needed: 2 },
      ],
      estimated_ready_at: '2026-11-24T14:00:00Z',
      external_source: null,
      external_ref: null,
    },
  ],
  jobs: [
    {
      id: 30,
      queue_item_id: 300,
      status: 'planned',
      printer_id: 7,
      printer_name: 'P1S-A',
      pinned: true,
      pieces: [{ part_id: 1, pieces: 2 }],
      product_plate_id: 10,
      filename: 'lid_x2.gcode.3mf',
      print_time_seconds: 7200,
      by_hand: false,
      moved: false,
    },
    {
      id: 31,
      queue_item_id: 301,
      status: 'planned',
      printer_id: 8,
      printer_name: 'P1S-B',
      pinned: false,
      pieces: [{ part_id: 2, pieces: 1 }],
      product_plate_id: 11,
      filename: 'base_x1.gcode.3mf',
      print_time_seconds: 3600,
      by_hand: false,
      moved: true,
    },
    {
      id: 32,
      queue_item_id: 302,
      status: 'planned',
      printer_id: null,
      printer_name: null,
      pinned: false,
      pieces: [{ part_id: 3, pieces: 1 }],
      product_plate_id: 12,
      filename: 'tray_x1.gcode.3mf',
      print_time_seconds: 1800,
      by_hand: true,
      moved: false,
      counted: false,
    },
  ],
  unplanned: [{ part_id: 3, pieces: 1 }],
};

let posted: unknown[];
let moved: unknown[];
let sjf = false;

beforeEach(() => {
  posted = [];
  moved = [];
  sjf = false;
  server.use(
    http.get('/api/v1/products/', () => HttpResponse.json([PRODUCT])),
    http.get('/api/v1/products/settings', () => HttpResponse.json({ plate_cost_minutes: 15, sjf_enabled: sjf })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 7, name: 'P1S-A' }, { id: 8, name: 'P1S-B' }])),
    http.post('/api/v1/products/4/stock/move', async ({ request }) => {
      moved.push(await request.json());
      return HttpResponse.json({
        product: DETAIL, planned_jobs: 0, created: 0, kept: 0, replaced: 0,
        ready_at: {}, finish_at: null, short: [], extra: [], skipped_plates: [],
      });
    }),
    http.get('/api/v1/products/4', () => HttpResponse.json(DETAIL)),
    http.post('/api/v1/products/4/orders', async ({ request }) => {
      posted.push(await request.json());
      const result: ProductPlanResult = {
        product: DETAIL,
        planned_jobs: 4,
        created: 2,
        kept: 2,
        replaced: 3,
        ready_at: {},
        finish_at: null,
        short: [],
        extra: [],
        skipped_plates: [],
      };
      return HttpResponse.json(result);
    }),
  );
});

const allowAll = () => true;

describe('ProductsView', () => {
  it('lists products with their parts', async () => {
    render(<ProductsView hasPermission={allowAll} />);
    expect(await screen.findByText('9mm box')).toBeInTheDocument();
    expect(screen.getByText(/Lid ×1 · Base ×1 · Tray ×1/)).toBeInTheDocument();
    expect(screen.getByText('Open: 1 orders, 2 pcs')).toBeInTheDocument();
  });

  it('opens a product on its orders, queued jobs and stock', async () => {
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByText('9mm box'));

    expect(await screen.findByText('2 pcs · 0 ready')).toBeInTheDocument();
    expect(screen.getByText('shop #12')).toBeInTheDocument();
    expect(screen.getByText('Tray: 1/2')).toBeInTheDocument();
    expect(screen.getByText('2× Lid')).toBeInTheDocument();
    expect(screen.getByText(/1× Tray · P1S-A/)).toBeInTheDocument();
    expect(screen.getByText('Not in the queue: 1× Tray. Replan to queue them again.')).toBeInTheDocument();
  });

  it('marks the jobs queued or moved by hand, which a plan keeps', async () => {
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByText('9mm box'));
    const moved = await screen.findByText('moved by hand');
    expect(moved).toHaveAttribute('title', expect.stringMatching(/a plan keeps it as it is/));
    expect(screen.getByText('queued by hand')).toBeInTheDocument();
    expect(screen.getAllByText(/by hand$/)).toHaveLength(2);
    // Printed by hand while such prints don't count: said so, once.
    expect(screen.getByText("doesn't count")).toHaveAttribute('title', expect.stringMatching(/no stock and no order/));
  });

  it('posts an order and reports the plan', async () => {
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: /Order/ }));
    const quantity = await screen.findByLabelText('Quantity');
    await user.clear(quantity);
    await user.type(quantity, '3');
    await user.click(screen.getByRole('button', { name: 'Add and plan' }));

    await waitFor(() => expect(posted).toEqual([{ quantity: 3, due_date: null, notes: null }]));
    expect(
      await screen.findByText('Plan updated: 4 plates in the queue (2 unchanged), 3 waiting jobs removed.'),
    ).toBeInTheDocument();
  });

  it('shows the picture and which parts dry after printing', async () => {
    const user = userEvent.setup();
    const { container } = render(<ProductsView hasPermission={allowAll} />);
    await screen.findByText('9mm box');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/products/4/thumbnail?v=abc');
    await user.click(screen.getByText('9mm box'));
    expect(await screen.findByText('Printed earlier, then worked on: Base 60 min, Tray 60 min.')).toBeInTheDocument();
  });

  it('moves pieces to another printer', async () => {
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByText('9mm box'));
    await user.click(await screen.findByRole('button', { name: 'Correct' }));
    await user.click(screen.getByRole('tab', { name: 'Move to another printer' }));
    const [part, from, to] = screen.getAllByRole('combobox');
    await user.selectOptions(part, '2');
    await user.selectOptions(from, '8');
    await user.selectOptions(to, '7');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(moved).toEqual([{ part_id: 2, from_printer_id: 8, to_printer_id: 7, pieces: 1, note: null }]),
    );
  });

  it('warns when shortest-first can reorder the plan', async () => {
    sjf = true;
    render(<ProductsView hasPermission={allowAll} />);
    expect(await screen.findByText(/"Shortest first" is on/)).toBeInTheDocument();
  });

  it('creates a product with a finishing time and uploads its picture', async () => {
    const created: unknown[] = [];
    let uploaded = false;
    server.use(
      http.post('/api/v1/products/', async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json({ ...DETAIL, id: 9, name: 'Clip' });
      }),
      http.post('/api/v1/products/9/thumbnail', async ({ request }) => {
        // jsdom's FormData does not parse back in msw; the multipart body is what matters.
        uploaded = (request.headers.get('content-type') ?? '').startsWith('multipart/form-data');
        return HttpResponse.json({ ...DETAIL, id: 9, name: 'Clip' });
      }),
    );
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: /New product/ }));
    await user.type(screen.getByPlaceholderText('e.g. 9mm box'), 'Clip');
    await user.type(screen.getByLabelText('Part name'), 'Base');
    const finish = screen.getByLabelText('after printing (min)');
    await user.clear(finish);
    await user.type(finish, '45');
    await user.upload(
      screen.getByLabelText('Upload picture…'),
      new File([new Uint8Array([137, 80, 78, 71])], 'clip.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(uploaded).toBe(true));
    expect(created).toEqual([
      {
        name: 'Clip',
        notes: null,
        parts: [{ id: null, name: 'Base', quantity: 1, matched: false, finish_minutes: 45 }],
        plates: [],
        skus: [],
      },
    ]);
  });

  it('hides the editing buttons without the right to queue', async () => {
    render(<ProductsView hasPermission={() => false} />);
    expect(await screen.findByText('9mm box')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New product/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Order/ })).not.toBeInTheDocument();
  });

  it('keeps the preferred-printer margin, the spool swap time and the colours in the planning settings', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('/api/v1/products/settings', () =>
        HttpResponse.json({
          plate_cost_minutes: 15,
          prefer_margin_minutes: 30,
          prefer_margin_pct: 25,
          filament_swap_minutes: 10,
          force_color: true,
        }),
      ),
      http.put('/api/v1/products/settings', async ({ request }) => {
        const body = await request.json();
        saved.push(body);
        return HttpResponse.json(body);
      }),
    );
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Planning' }));
    const minutes = await screen.findByRole('spinbutton', { name: /A preferred printer loses/ });
    expect(minutes).toHaveValue(30);
    await user.clear(minutes);
    await user.type(minutes, '45');
    await user.tab();
    await waitFor(() => expect(saved).toEqual([{ plate_cost_minutes: 15, prefer_margin_minutes: 45 }]));

    await user.click(screen.getByRole('checkbox', { name: /Order plates ask for the colours/ }));
    await waitFor(() => expect(saved[1]).toEqual({ plate_cost_minutes: 15, force_color: false }));

    // Plates printed by hand: off unless set, turned on here.
    const hand = screen.getByRole('checkbox', { name: /Plates printed by hand count/ });
    expect(hand).not.toBeChecked();
    await user.click(hand);
    await waitFor(() => expect(saved[2]).toEqual({ plate_cost_minutes: 15, hand_prints_count: true }));
    expect(screen.getByRole('spinbutton', { name: 'Loading or changing a spool takes' })).toHaveValue(10);
  });

  // Fork (UI fixes): Base orders, plan notes, times, grouping, the order dialog and the advanced settings.
  it('shows an order from Base read-only, with a link to it on the Orders page', async () => {
    const baseOrder = {
      ...DETAIL.orders[0],
      id: 21,
      notes: 'nick_7001',
      external_source: 'base',
      external_ref: '7001/4',
      base_order_id: 7001,
    };
    server.use(http.get('/api/v1/products/4', () => HttpResponse.json({ ...DETAIL, orders: [baseOrder] })));
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByText('9mm box'));
    const link = await screen.findByRole('link', { name: /Base order nick_7001/ });
    expect(link).toHaveAttribute('href', '/orders?order=7001');
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    // The product's own Edit only.
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  });

  it('marks a late order and says why another has no estimate', async () => {
    const late = { ...DETAIL.orders[0], due_date: '2026-11-24T12:00:00Z' };
    const none = { ...DETAIL.orders[0], id: 22, estimated_ready_at: null, no_estimate_reason: 'held' as const };
    server.use(http.get('/api/v1/products/4', () => HttpResponse.json({ ...DETAIL, orders: [late, none] })));
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByText('9mm box'));
    expect(await screen.findByText('late')).toBeInTheDocument();
    expect(screen.getByText('no estimate: its plates are held in the queue')).toBeInTheDocument();
  });

  it('shows a time learnt from history with the slicer\'s, and groups identical plates with a link to the queue', async () => {
    const learnt = { ...DETAIL.jobs[0], planned_seconds: 9600, print_time_seconds: 7800, learned: true };
    server.use(
      http.get('/api/v1/products/4', () =>
        HttpResponse.json({ ...DETAIL, jobs: [learnt, { ...learnt, id: 33, queue_item_id: 303 }, DETAIL.jobs[1]] }),
      ),
    );
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByText('9mm box'));
    expect((await screen.findAllByText('2h 40m from history')).length).toBe(1);
    expect(screen.getByText(/slicer estimate 2h 10m/)).toBeInTheDocument();
    // Said in words ("2 plates · 2× Lid", not "2× 2× Lid"); nothing extra on a single plate.
    expect(screen.getByText('2 plates ·')).toBeInTheDocument();
    expect(screen.queryByText(/^1 plate/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show lid_x2.gcode.3mf in the queue' })).toHaveAttribute(
      'href',
      '/queue?tab=timeline&item=300',
    );
  });

  it('names the other products a plan redid and keeps a failed one on screen', async () => {
    server.use(
      http.post('/api/v1/products/4/orders', () =>
        HttpResponse.json({
          product: DETAIL, planned_jobs: 1, created: 1, kept: 0, replaced: 0, ready_at: {}, finish_at: null,
          short: [], extra: [], skipped_plates: [],
          also_replanned: [{ product_id: 5, name: 'Clip', created: 1, replaced: 2 }],
          plan_failed: [{ product_id: 6, name: 'Tray box' }],
        }),
      ),
    );
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: /Order/ }));
    await user.click(await screen.findByRole('button', { name: 'Add and plan' }));
    expect(await screen.findByText('Queued plates: 1. Also replanned: Clip.')).toBeInTheDocument();
    expect(screen.getByText(/Could not plan: Tray box/)).toBeInTheDocument();
  });

  it('cannot be closed while the order is being planned', async () => {
    let release: () => void = () => {};
    server.use(
      http.post('/api/v1/products/4/orders', async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return HttpResponse.json({
          product: DETAIL, planned_jobs: 0, created: 0, kept: 0, replaced: 0, ready_at: {}, finish_at: null,
          short: [], extra: [], skipped_plates: [],
        });
      }),
    );
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: /Order/ }));
    await user.click(await screen.findByRole('button', { name: 'Add and plan' }));
    expect(await screen.findByText('Planning… this takes a few seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument());
  });

  it('turns the advanced planning settings on and off', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('/api/v1/products/settings', () =>
        HttpResponse.json({ plate_cost_minutes: 15, reservation_yield: true, learn_history: true }),
      ),
      http.put('/api/v1/products/settings', async ({ request }) => {
        const body = await request.json();
        saved.push(body);
        return HttpResponse.json({ plate_cost_minutes: 15, reservation_yield: true, learn_history: true, ...(body as object) });
      }),
    );
    const user = userEvent.setup();
    render(<ProductsView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('button', { name: 'Planning' }));
    expect(await screen.findByText('Advanced')).toBeInTheDocument();
    const yieldBox = screen.getByRole('checkbox', { name: /The planner's reservations give way/ });
    expect(yieldBox).toBeChecked();
    await user.click(yieldBox);
    await waitFor(() => expect(saved).toEqual([{ plate_cost_minutes: 15, reservation_yield: false }]));
    await user.click(screen.getByRole('checkbox', { name: /Times and risk from print history/ }));
    await waitFor(() => expect(saved[1]).toEqual({ plate_cost_minutes: 15, learn_history: false }));
  });
});
