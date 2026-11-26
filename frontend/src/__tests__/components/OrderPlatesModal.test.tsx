/**
 * Fork (Base sync): the plates the plan prints for an order, with a preferred printer per plate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { OrderPlatesModal } from '../../components/products/OrderPlatesModal';
import type { BaseOrder, BaseOrderPlate } from '../../api/client';

const ORDER = {
  order_id: 5001,
  number: null,
  label: 'nick_5001',
  buyer_login: 'nick_5001',
  source: 'allegro',
  source_kind: 'allegro',
  source_name: 'Allegro Shop A',
  date_confirmed: null,
  ship_by: null,
  state: 'accepted',
  in_status: true,
  lines: [],
  product_orders: [],
  ready: false,
  held: {},
  on_hand: {},
  draft: null,
  progress: [],
} as BaseOrder;

function soon(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

const LID: BaseOrderPlate = {
  job_id: 11,
  queue_item_id: 101,
  product_id: 4,
  product_name: '9mm 100 Black',
  library_file_id: 7,
  filename: 'lid_x2.gcode.3mf',
  plate_index: null,
  has_thumbnail: false,
  pieces: [{ part_id: 41, name: 'Lid', pieces: 2 }],
  status: 'planned',
  pinned: false,
  by_hand: false,
  moved: false,
  printer_id: 1,
  printer_name: 'P1S-A',
  start: soon(1),
  end: soon(3),
  preferred_printer_id: null,
  overruled: null,
  overruled_by_s: 0,
  swap: null,
  filament: [{ type: 'PETG', color: '#00ae42', grams: 182.4, tray: 0, left: 640.2, swap: null }],
  printers: [
    { id: 1, name: 'P1S-A', available: true },
    { id: 2, name: 'P1S-B', available: true },
    { id: 3, name: 'P1S-C', available: false },
  ],
  editable: true,
  orders: ['nick_5001', '#1243'],
};

let plates: BaseOrderPlate[];
let preferences: { jobId: number; body: unknown }[];

beforeEach(() => {
  plates = [LID];
  preferences = [];
  server.use(
    http.get('/api/v1/base-sync/orders/:id/plates', () => HttpResponse.json(plates)),
    http.put('/api/v1/products/jobs/:id/preference', async ({ params, request }) => {
      const body = (await request.json()) as { printer_id: number | null };
      preferences.push({ jobId: Number(params.id), body });
      // The replan keeps the plate where it is, preferring the printer chosen.
      plates = plates.map((p) => (p.job_id === Number(params.id) ? { ...p, preferred_printer_id: body.printer_id } : p));
      return HttpResponse.json({});
    }),
  );
});

describe('OrderPlatesModal', () => {
  it('lists each plate with its printer, filament and what is left on the spool', async () => {
    render(<OrderPlatesModal order={ORDER} canAct onClose={() => {}} />);
    expect(await screen.findByText('lid_x2')).toBeInTheDocument();
    expect(screen.getByText(/9mm 100 Black · Lid ×2/)).toBeInTheDocument();
    expect(screen.getByText(/^P1S-A · /)).toBeInTheDocument();
    expect(screen.getByText('PETG 182 g')).toBeInTheDocument();
    expect(screen.getByText('~640 g left')).toBeInTheDocument();
    // Other orders the plate prints for.
    expect(screen.getByText('Also for: #1243')).toBeInTheDocument();
  });

  it('starts on Automatic and saves a preferred printer, then Automatic again', async () => {
    const user = userEvent.setup();
    render(<OrderPlatesModal order={ORDER} canAct onClose={() => {}} />);
    const select = await screen.findByRole('combobox', { name: 'Preferred printer for lid_x2' });
    expect(select).toHaveValue('');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Automatic', 'P1S-A', 'P1S-B', 'P1S-C (offline)']);

    await user.selectOptions(select, '2');
    await waitFor(() => expect(preferences).toEqual([{ jobId: 11, body: { printer_id: 2 } }]));
    expect(await screen.findByText('Saved – the plan is recalculated.')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('2'));
    await user.selectOptions(screen.getByRole('combobox'), '');
    await waitFor(() => expect(preferences[1]).toEqual({ jobId: 11, body: { printer_id: null } }));
  });

  it('says why a plate is not on the preferred printer', async () => {
    plates = [{ ...LID, preferred_printer_id: 2, overruled: 'earlier', overruled_by_s: 2 * 3600 + 600 }];
    render(<OrderPlatesModal order={ORDER} canAct onClose={() => {}} />);
    expect(await screen.findByText('P1S-A is done 2h 10m sooner than P1S-B.')).toBeInTheDocument();
  });

  it('warns when a spool has to be loaded or changed first', async () => {
    plates = [
      {
        ...LID,
        swap: 'load',
        filament: [{ type: 'PETG', color: '#00ae42', grams: 100, tray: null, left: 900, swap: 'load' }],
      },
      {
        ...LID,
        job_id: 12,
        filename: 'base_x2.gcode.3mf',
        swap: 'change',
        filament: [{ type: 'PETG', color: '#00ae42', grams: 100, tray: 1, left: 900, swap: 'change' }],
      },
    ];
    render(<OrderPlatesModal order={ORDER} canAct onClose={() => {}} />);
    expect(await screen.findByText('Load PETG first')).toBeInTheDocument();
    expect(screen.getByText('The spool runs out – change it first')).toBeInTheDocument();
  });

  it('offers no choice for a plate printing, moved by hand, or without the permission', async () => {
    plates = [
      { ...LID, status: 'printing', editable: false, start: null },
      { ...LID, job_id: 12, filename: 'base_x2.gcode.3mf', moved: true, editable: false },
    ];
    const { unmount } = render(<OrderPlatesModal order={ORDER} canAct onClose={() => {}} />);
    expect(await screen.findByText(/^Printing on P1S-A · until /)).toBeInTheDocument();
    expect(screen.getByText('Moved by hand – it stays on this printer.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    unmount();

    plates = [LID];
    render(<OrderPlatesModal order={ORDER} canAct={false} onClose={() => {}} />);
    expect(await screen.findByText('lid_x2')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('says when nothing of the order waits in the queue, and closes', async () => {
    plates = [];
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<OrderPlatesModal order={ORDER} canAct onClose={onClose} />);
    expect(await screen.findByText('Nothing of this order is waiting in the queue.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
