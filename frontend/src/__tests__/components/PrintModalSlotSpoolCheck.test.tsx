/**
 * Fork (slot spools): the print dialog weighs filament the way the dispatcher
 * does with `filament_check_per_slot` and `filament_check_margin_pct` — every
 * slot on its own spool even with AMS Filament Backup on, the margin on top,
 * and a roll nothing counts reported as unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { PrintModal } from '../../components/PrintModal';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { server } from '../mocks/server';

const mockPrinters = [
  { id: 1, name: 'X1 Carbon', model: 'X1C', ip_address: '192.168.1.100', enabled: true, is_active: true },
];

const PLATES = {
  is_multi_plate: true,
  plates: [
    { index: 1, name: 'Plate 1', has_thumbnail: false, thumbnail_url: null, objects: ['A'], filaments: [{ type: 'PLA', color: '#FF0000' }], print_time_seconds: 1800, filament_used_grams: 40 },
    { index: 2, name: 'Plate 2', has_thumbnail: false, thumbnail_url: null, objects: ['B'], filaments: [{ type: 'PLA', color: '#FF0000' }], print_time_seconds: 1800, filament_used_grams: 40 },
  ],
};
const SLOT_1_RED = { slot_id: 1, type: 'PLA', color: '#FF0000', tray_info_idx: '', used_grams: 40 };
const SLOT_2_RED = { slot_id: 2, type: 'PLA', color: '#FF0000', tray_info_idx: '', used_grams: 40 };

const render = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ThemeProvider>
            <ToastProvider>{ui}</ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
};

const settings = (perSlot: boolean, marginPct: number) => {
  const body = { filament_check_per_slot: perSlot, filament_check_margin_pct: marginPct };
  return [
    http.get('/api/v1/settings/', () => HttpResponse.json(body)),
    http.get('/api/v1/settings/ui-flags', () => HttpResponse.json(body)),
  ];
};

// Two red trays of the same material, so AMS Filament Backup could switch.
const twoRedTrays = (remain = 50) =>
  http.get('/api/v1/printers/:id/status', () =>
    HttpResponse.json({
      connected: true,
      state: 'IDLE',
      ams_filament_backup: true,
      ams: [{ id: 0, tray: [
        { id: 0, tray_type: 'PLA', tray_color: 'FF0000', remain },
        { id: 1, tray_type: 'PLA', tray_color: 'FF0000', remain },
      ] }],
      vt_tray: [],
    }),
  );

const redPool = (trayZeroGrams: number, trayOneGrams: number) =>
  http.get('/api/v1/printers/:id/inventory-remain', () =>
    HttpResponse.json({
      inventory_remain_g: { '0': trayZeroGrams, '1': trayOneGrams },
      slot_materials: [
        { ams_id: 0, tray_id: 0, global_tray_id: 0, material_key: 'preset:GFA00|color:FF0000', remaining_g: trayZeroGrams, extruder: 0 },
        { ams_id: 0, tray_id: 1, global_tray_id: 1, material_key: 'preset:GFA00|color:FF0000', remaining_g: trayOneGrams, extruder: 0 },
      ],
    }),
  );

async function submitBothPlates() {
  const user = userEvent.setup();
  render(<PrintModal mode="create" archiveId={1} archiveName="Two.gcode.3mf" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());
  await user.click(screen.getByText('X1 Carbon'));
  await waitFor(() => expect(screen.getByText('Plate 2')).toBeInTheDocument());
  await user.click(screen.getByText('Plate 2'));
  await waitFor(() => expect(screen.getByText(/Filament Mapping — Plate 2/)).toBeInTheDocument());
  await user.click(document.querySelector('button[type="submit"]') as HTMLElement);
}

describe('PrintModal filament check with slot spools (fork)', () => {
  const queued: unknown[] = [];

  beforeEach(() => {
    queued.length = 0;
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json(mockPrinters)),
      http.get('/api/v1/archives/:id/plates', () => HttpResponse.json(PLATES)),
      http.get('/api/v1/archives/:id/filament-requirements', ({ request }) => {
        const plateId = new URL(request.url).searchParams.get('plate_id');
        if (plateId === '1') return HttpResponse.json({ filaments: [SLOT_1_RED] });
        if (plateId === '2') return HttpResponse.json({ filaments: [SLOT_2_RED] });
        return HttpResponse.json({ filaments: [SLOT_1_RED, SLOT_2_RED] });
      }),
      http.get('/api/v1/printers/:id/assignments', () => HttpResponse.json([])),
      http.post('/api/v1/queue/', async ({ request }) => {
        queued.push(await request.json());
        return HttpResponse.json({ id: queued.length, status: 'pending' });
      }),
    );
  });

  it('does not count the backup spool when each slot is checked on its own', async () => {
    // 80 g from a tray holding 60 g, a full twin next to it and backup on: the
    // printer would finish on the twin, and the switch marks the print.
    server.use(...settings(true, 0), twoRedTrays(), redPool(60, 1000));
    await submitBothPlates();

    await waitFor(() => expect(screen.getByText(/Not enough filament/i)).toBeInTheDocument());
    expect(screen.getByText(/needs 80g, remaining 60g/i)).toBeInTheDocument();
    expect(queued).toHaveLength(0);
  });

  it('still pools the backup spool with the setting off', async () => {
    server.use(...settings(false, 0), twoRedTrays(), redPool(60, 1000));
    await submitBothPlates();

    await waitFor(() => expect(queued).toHaveLength(2));
    expect(screen.queryByText(/Not enough filament/i)).not.toBeInTheDocument();
  });

  it('asks for the margin on top of the sliced grams', async () => {
    // 80 g + 5 % = 84 g against 82 g left.
    server.use(...settings(true, 5), twoRedTrays(), redPool(82, 0));
    await submitBothPlates();

    await waitFor(() => expect(screen.getByText(/Not enough filament/i)).toBeInTheDocument());
    expect(screen.getByText(/needs 84g, remaining 82g/i)).toBeInTheDocument();
  });

  it('reports a roll nothing counts as unknown', async () => {
    server.use(
      ...settings(true, 0),
      twoRedTrays(-1),
      http.get('/api/v1/printers/:id/inventory-remain', () =>
        HttpResponse.json({ inventory_remain_g: {}, slot_materials: [] }),
      ),
    );
    await submitBothPlates();

    await waitFor(() => expect(screen.getByText(/Not enough filament/i)).toBeInTheDocument());
    expect(screen.getByText(/needs 80g, amount on the roll unknown/i)).toBeInTheDocument();
  });
});
