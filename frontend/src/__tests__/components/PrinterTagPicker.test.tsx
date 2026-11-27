/**
 * Fork (printer tags): the tag picker on a touch screen, and the printer edit
 * dialog saying which part of a save failed (the tags go first).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { PrinterTagPicker } from '../../components/PrinterTagPicker';
import { PrintersPage } from '../../pages/PrintersPage';

const options = [
  { id: 1, name: 'Fast' },
  { id: 2, name: 'Hardened' },
];

const realMatchMedia = window.matchMedia;

function touchScreen(coarse: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query.includes('coarse'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
}

describe('PrinterTagPicker', () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('on a touch screen opens the list without the keyboard, and brings it into view', async () => {
    touchScreen(true);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const user = userEvent.setup();
    render(<PrinterTagPicker value={[]} onChange={vi.fn()} options={options} />);

    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    expect(screen.getByRole('button', { name: 'Fast' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tags')).not.toHaveFocus();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('with a mouse focuses the search field', async () => {
    touchScreen(false);
    const user = userEvent.setup();
    render(<PrinterTagPicker value={[]} onChange={vi.fn()} options={options} />);
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(screen.getByPlaceholderText('Search tags')).toHaveFocus();
  });
});

describe('printer edit dialog with tags', () => {
  it('says the tags were saved when only the printer failed', async () => {
    const printer = {
      id: 9,
      name: 'Tagged X1C',
      ip_address: '192.0.2.19',
      serial_number: '00M09A350100009',
      access_code: '12345678',
      model: 'X1C',
      enabled: true,
      is_active: true,
      nozzle_diameter: 0.4,
      nozzle_type: 'hardened_steel',
      auto_archive: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };
    const tagSaves: unknown[] = [];
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([printer])),
      http.get('/api/v1/printers/:id/status', () =>
        HttpResponse.json({ connected: true, state: 'IDLE', temperatures: {}, vt_tray: [], ams: [] }),
      ),
      http.get('/api/v1/library/tags', () => HttpResponse.json(options)),
      http.post('/api/v1/printers/diagnostic', () => HttpResponse.json({ checks: [] })),
      http.put('/api/v1/printer-tags/:id', async ({ request }) => {
        tagSaves.push(await request.json());
        return HttpResponse.json({ printer_id: printer.id, tag_ids: [1], exclusive: false });
      }),
      http.patch('/api/v1/printers/:id', () => HttpResponse.json({ detail: 'Name taken' }, { status: 400 })),
    );
    const user = userEvent.setup();
    render(<PrintersPage />);

    await user.click((await screen.findAllByTitle(/more$/))[0]);
    await user.click(await screen.findByRole('button', { name: /^Edit$/ }));
    await user.click(await screen.findByRole('button', { name: 'Add tag' }));
    await user.click(await screen.findByRole('button', { name: 'Fast' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText(/Tags saved, but the printer was not: Name taken/)).toBeInTheDocument();
    expect(tagSaves).toHaveLength(1);
  });
});
