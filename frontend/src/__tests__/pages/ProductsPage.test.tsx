/**
 * Fork (products): the Products page shows products and, in a second tab, orders from Base.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProductsPage } from '../../pages/ProductsPage';

beforeEach(() => {
  localStorage.removeItem('products.activeTab');
  server.use(
    http.get('/api/v1/products/', () => HttpResponse.json([])),
    http.get('/api/v1/products/settings', () => HttpResponse.json({ plate_cost_minutes: 15, sjf_enabled: false })),
    http.get('/api/v1/base-sync/settings', () =>
      HttpResponse.json({
        enabled: false, status_id: null, cancel_status_id: null, sources: [], poll_minutes: 5,
        auto_accept: false, manual_start: false, handling_days: 0, token_set: false,
        last_run_at: null, last_ok_at: null, last_error: null,
      }),
    ),
  );
});

describe('ProductsPage', () => {
  it('has a heading and switches to the Base orders tab', async () => {
    const user = userEvent.setup();
    render(<ProductsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Products' })).toBeInTheDocument();
    expect(await screen.findByText('No products yet')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Orders from Base' }));
    expect(await screen.findByText('Base is not connected')).toBeInTheDocument();
  });
});
