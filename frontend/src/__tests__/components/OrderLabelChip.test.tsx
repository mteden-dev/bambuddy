/**
 * Fork (products): the label saying which order a print is for.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { OrderLabelChip } from '../../components/OrderLabelChip';
import type { ProductOrderTag } from '../../api/client';

const tag = (overrides: Partial<ProductOrderTag>): ProductOrderTag => ({
  product_order_id: 1,
  label: 'nick_a',
  title: 'Base 52054001 · Allegro Shop A',
  base_order_id: 52054001,
  source_kind: 'allegro',
  ship_by: '2099-01-02T22:59:59Z',
  due: null,
  ...overrides,
});

beforeEach(() => {
  server.use(
    http.get('/api/v1/products/order-tags', () =>
      HttpResponse.json({
        items: {
          '10': {
            orders: [
              tag({ product_order_id: 2, label: '#1244', source_kind: 'shop', ship_by: null, base_order_id: 52054002, title: 'Base 52054002 · Sklep' }),
              tag({}),
            ],
            for_stock: false,
          },
          '11': { orders: [], for_stock: true },
        },
        printers: { '3': { orders: [tag({})], for_stock: false } },
      }),
    ),
  );
});

describe('OrderLabelChip', () => {
  it('shows the most urgent order and how many more, with the Base ids on hover', async () => {
    render(<OrderLabelChip itemId={10} />);
    const chip = await screen.findByRole('button', { name: 'nick_a +1' });
    expect(chip.getAttribute('title')).toContain('Base 52054001');
    expect(chip.getAttribute('title')).toContain('Base 52054002');
  });

  it('lists the orders on a tap, each a link to its order', async () => {
    const user = userEvent.setup();
    render(<OrderLabelChip itemId={10} />);
    await user.click(await screen.findByRole('button', { name: 'nick_a +1' }));
    expect(screen.getByText('Planned; may change after a replan.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /#1244/ }));
    expect(window.location.search).toBe('?tab=base&order=52054002');
  });

  it('says a plate is for stock, and labels a printer by what it prints', async () => {
    render(
      <>
        <OrderLabelChip itemId={11} />
        <OrderLabelChip printerId={3} />
        <OrderLabelChip itemId={99} />
      </>,
    );
    expect(await screen.findByRole('button', { name: 'for stock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'nick_a' })).toBeInTheDocument();
  });

  it('lists every order in the job details', async () => {
    render(<OrderLabelChip itemId={10} variant="list" />);
    expect(await screen.findByText('For orders:')).toBeInTheDocument();
    expect(screen.getByText(/^nick_a · Base 52054001/)).toBeInTheDocument();
  });
});
