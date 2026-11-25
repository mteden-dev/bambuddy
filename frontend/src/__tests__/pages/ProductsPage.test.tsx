/**
 * Fork (products): the Products page shows products; orders from Base and the prints to check have their own page.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProductsPage } from '../../pages/ProductsPage';
import { OrdersPage } from '../../pages/OrdersPage';

beforeEach(() => {
  localStorage.removeItem('orders.activeTab');
  server.use(
    http.get('/api/v1/products/', () => HttpResponse.json([])),
    http.get('/api/v1/products/settings', () => HttpResponse.json({ plate_cost_minutes: 15, sjf_enabled: false })),
    http.get('/api/v1/base-sync/settings', () =>
      HttpResponse.json({
        enabled: false, status_ids: [], cancel_status_id: null, sources: [], poll_minutes: 5,
        auto_accept: false, manual_start: false, handling_days: 0, since: null, token_set: false,
        last_run_at: null, last_ok_at: null, last_error: null,
      }),
    ),
  );
});

describe('ProductsPage', () => {
  it('has a heading and the products, without the orders', async () => {
    render(<ProductsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Products' })).toBeInTheDocument();
    expect(await screen.findByText('No products yet')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Orders from Base' })).toBeNull();
  });
});

describe('OrdersPage', () => {
  it('has a heading, the Base orders and the prints to check', async () => {
    server.use(http.get('/api/v1/products/qc', () => HttpResponse.json([])));
    const user = userEvent.setup();
    render(<OrdersPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeInTheDocument();
    expect(await screen.findByText('Base is not connected')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'To check' }));
    expect(screen.getByRole('tab', { name: 'To check' })).toHaveAttribute('aria-selected', 'true');
  });
});
