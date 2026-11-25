/**
 * Fork (products): cancelling a waiting print the planner made for orders asks
 * what becomes of its parts: print again, on hand already, or withdraw orders.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { OrderJobCancelModal } from '../../components/products/OrderJobCancelModal';
import type { ProductJobOrders } from '../../api/client';

const ENTRY: ProductJobOrders = {
  orders: [
    {
      product_order_id: 9,
      label: 'nick_a',
      title: 'Base 5001 · Allegro Shop A',
      base_order_id: 5001,
      source_kind: 'allegro',
      ship_by: null,
      due: null,
    },
    {
      product_order_id: 10,
      label: 'nick_b',
      title: 'Base 5002 · Allegro Shop A',
      base_order_id: 5002,
      source_kind: 'allegro',
      ship_by: null,
      due: null,
    },
  ],
  for_stock: false,
};

const REPLY = {
  replanned: [4],
  created: 1,
  kept: 2,
  stocked: [],
  withdrawn: [],
  withdrawn_base_orders: [],
  short: [],
};

let sent: { id: number; body: unknown }[];

beforeEach(() => {
  sent = [];
  server.use(
    http.post('/api/v1/products/queue-items/:id/cancel', async ({ params, request }) => {
      sent.push({ id: Number(params.id), body: await request.json() });
      return HttpResponse.json(REPLY);
    }),
  );
});

describe('OrderJobCancelModal', () => {
  it('names the orders and waits for a choice', () => {
    render(<OrderJobCancelModal itemId={77} name="lid_x2.gcode.3mf" entry={ENTRY} onClose={() => {}} />);
    expect(screen.getByText('Cancel a print made for orders?')).toBeInTheDocument();
    expect(screen.getByText('nick_a')).toBeInTheDocument();
    expect(screen.getByText('nick_b')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose' })).toBeDisabled();
  });

  it('prints it again', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<OrderJobCancelModal itemId={77} name="lid_x2.gcode.3mf" entry={ENTRY} onClose={onClose} />);
    await user.click(screen.getByRole('radio', { name: /^Print it again/ }));
    await user.click(screen.getByRole('button', { name: 'Print again' }));
    await waitFor(() => expect(sent).toEqual([{ id: 77, body: { then: 'replan' } }]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('puts the parts in stock', async () => {
    const user = userEvent.setup();
    render(<OrderJobCancelModal itemId={77} name="lid_x2.gcode.3mf" entry={ENTRY} onClose={() => {}} />);
    await user.click(screen.getByRole('radio', { name: /^I have these parts/ }));
    await user.click(screen.getByRole('button', { name: 'Put in stock' }));
    await waitFor(() => expect(sent).toEqual([{ id: 77, body: { then: 'stock' } }]));
  });

  it('withdraws only the orders left ticked', async () => {
    const user = userEvent.setup();
    render(<OrderJobCancelModal itemId={77} name="lid_x2.gcode.3mf" entry={ENTRY} onClose={() => {}} />);
    await user.click(screen.getByRole('radio', { name: /^Withdraw the order/ }));
    await user.click(screen.getByRole('checkbox', { name: /nick_b/ }));
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(sent).toEqual([{ id: 77, body: { then: 'withdraw', orders: [9] } }]));
  });

  it('cannot withdraw with no order ticked', async () => {
    const user = userEvent.setup();
    render(<OrderJobCancelModal itemId={77} name="lid_x2.gcode.3mf" entry={ENTRY} onClose={() => {}} />);
    await user.click(screen.getByRole('radio', { name: /^Withdraw the order/ }));
    await user.click(screen.getByRole('checkbox', { name: /nick_a/ }));
    await user.click(screen.getByRole('checkbox', { name: /nick_b/ }));
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  });
});
