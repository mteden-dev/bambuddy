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
    { id: 1, name: 'Lid', quantity: 1, matched: true },
    { id: 2, name: 'Base', quantity: 1, matched: true },
    { id: 3, name: 'Tray', quantity: 1, matched: false },
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
  open_orders: 1,
  open_units: 2,
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
    },
  ],
  unplanned: [{ part_id: 3, pieces: 1 }],
};

let posted: unknown[];

beforeEach(() => {
  posted = [];
  server.use(
    http.get('/api/v1/products/', () => HttpResponse.json([PRODUCT])),
    http.get('/api/v1/products/settings', () => HttpResponse.json({ plate_cost_minutes: 15 })),
    http.get('/api/v1/products/4', () => HttpResponse.json(DETAIL)),
    http.post('/api/v1/products/4/orders', async ({ request }) => {
      posted.push(await request.json());
      const result: ProductPlanResult = {
        product: DETAIL,
        planned_jobs: 4,
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
    expect(screen.getByRole('heading', { level: 1, name: 'Products' })).toBeInTheDocument();
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
      await screen.findByText('Plan updated: 4 plates queued, 3 waiting jobs replaced.'),
    ).toBeInTheDocument();
  });

  it('hides the editing buttons without the right to queue', async () => {
    render(<ProductsView hasPermission={() => false} />);
    expect(await screen.findByText('9mm box')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New product/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Order/ })).not.toBeInTheDocument();
  });
});
