/**
 * Fork: clearing the plate names the next job that will not start by itself,
 * and it is the same job the card's queue widget shows as next: the first one
 * this printer's filaments fit, not the first pending job of any filament.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';

const printer = {
  id: 7,
  name: 'Bench P1S',
  ip_address: '192.0.2.17',
  serial_number: '01P00A000000007',
  access_code: '12345678',
  model: 'P1S',
  enabled: true,
  is_active: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'stainless_steel',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const tray = (id: number, type: string, color: string) => ({
  id,
  tray_color: color,
  tray_type: type,
  tray_sub_brands: '',
  tray_id_name: '',
  tray_info_idx: 'GFL99',
  remain: 80,
  k: 0.02,
  cali_idx: null,
  tag_uid: null,
  tray_uuid: null,
  nozzle_temp_min: 190,
  nozzle_temp_max: 230,
  state: 11,
  exists: true,
});

const status = {
  connected: true,
  state: 'FINISH',
  awaiting_plate_clear: true,
  progress: 100,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  vt_tray: [],
  ams: [
    {
      id: 0,
      humidity: 30,
      temp: 25,
      tray: [tray(0, 'PLA', 'FFFFFFFF')],
    },
  ],
};

const job = (id: number, name: string, types: string[], extra: Record<string, unknown> = {}) => ({
  id,
  printer_id: null,
  target_model: 'P1S',
  archive_id: id,
  archive_name: name,
  status: 'pending',
  position: id,
  manual_start: true,
  required_filament_types: types,
  filament_overrides: null,
  created_at: '2024-01-01T00:00:00Z',
  ...extra,
});

describe('clearing the plate', () => {
  it('names the next job the card shows, not one this printer cannot print', async () => {
    const queue = [
      // First in line, but asks for PETG, which this printer has not loaded.
      job(1, 'Petg bracket', ['PETG'], { waiting_reason: 'No PETG loaded' }),
      job(2, 'Pla clip', ['PLA']),
    ];
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([printer])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(status)),
      http.get('/api/v1/queue/', () => HttpResponse.json(queue)),
      http.get('/api/v1/bulk/printer-queues', () => HttpResponse.json({ [printer.id]: queue })),
      http.post('/api/v1/printers/:id/clear-plate', () => HttpResponse.json({ success: true, message: 'ok' })),
      http.get('/api/v1/settings/', () => HttpResponse.json({ require_plate_clear: true, currency: 'USD' })),
      http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({ require_plate_clear: true })),
    );
    render(<PrintersPage />);

    const clear = await screen.findAllByRole('button', { name: 'Mark plate as cleared' });
    // The widget has the queue by now.
    await waitFor(() => expect(screen.getAllByText(/Pla clip/).length).toBeGreaterThan(0));
    fireEvent.click(clear[0]);

    await waitFor(() => expect(screen.getByText(/Pla clip will not start by itself/)).toBeInTheDocument());
    expect(screen.queryByText(/Petg bracket will not start by itself/)).not.toBeInTheDocument();
  });
});
