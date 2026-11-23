/**
 * Fork (slot spools) on the printer card: a roll nothing counts lights up as
 * "new" and offers to load it, a slot emptied and refilled under its slot
 * spool asks "same roll?", and a counted slot spool offers to correct its
 * amount. Spoolman mode lights nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';

const PRINTER_ID = 5;

const mockPrinter = {
  id: PRINTER_ID,
  name: 'AMS X1C',
  ip_address: '192.0.2.105',
  serial_number: '00M09A350100005',
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const tray = (id: number, extra: Record<string, unknown>) => ({
  id,
  tray_color: 'FF0000FF',
  tray_type: 'PLA',
  tray_sub_brands: '',
  tray_id_name: '',
  tray_info_idx: 'GFL99',
  remain: -1,
  k: 0.02,
  cali_idx: null,
  tag_uid: null,
  tray_uuid: null,
  nozzle_temp_min: 190,
  nozzle_temp_max: 230,
  drying_temp: null,
  drying_time: null,
  state: 11,
  exists: true,
  ...extra,
});

const status = {
  connected: true,
  state: 'IDLE',
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  speed_level: 2,
  vt_tray: [],
  ams: [
    {
      id: 0,
      humidity: 30,
      temp: 25,
      is_ams_ht: false,
      serial_number: 'AMS0SERIAL',
      sw_ver: '1.0.0',
      dry_time: 0,
      dry_status: 0,
      dry_sub_status: 0,
      dry_sf_reason: [],
      module_type: 'ams',
      tray: [
        // A roll just pushed in, unidentified ("?"), no spool: new.
        tray(0, { tray_type: '', tray_color: '', tray_info_idx: '' }),
        // Its slot spool is assigned and the slot was emptied and refilled.
        tray(1, {}),
        // A Bambu RFID roll: the inventory handles it by its tag.
        tray(2, { tray_uuid: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' }),
        // Empty.
        tray(3, { exists: false, tray_type: '', tray_color: '' }),
      ],
    },
  ],
};

const slotSpool = {
  id: 77,
  material: 'PLA',
  subtype: null,
  brand: null,
  color_name: null,
  rgba: 'FF0000FF',
  label_weight: 1000,
  weight_used: 350,
  data_origin: 'slot_quick',
};

function setup({ spoolman = false } = {}) {
  const sent: { method: string; path: string }[] = [];
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json(status)),
    http.get('/api/v1/printers/:id/ams-labels', () => HttpResponse.json({})),
    http.get('/api/v1/spoolman/status', () =>
      HttpResponse.json({ enabled: spoolman, connected: spoolman, url: spoolman ? 'http://spoolman' : null }),
    ),
    http.get('/api/v1/spoolman/inventory/slot-assignments/all', () => HttpResponse.json([])),
    http.get('/api/v1/spoolman/inventory/spools', () => HttpResponse.json([])),
    http.get('/api/v1/inventory/assignments', () =>
      HttpResponse.json([
        {
          id: 1,
          spool_id: 77,
          printer_id: PRINTER_ID,
          printer_name: 'AMS X1C',
          ams_id: 0,
          tray_id: 1,
          fingerprint_color: 'FF0000FF',
          fingerprint_type: 'PLA',
          spool: slotSpool,
          configured: true,
          created_at: '2024-01-01T00:00:00Z',
        },
      ]),
    ),
    http.get('/api/v1/slot-spools/prompts', () =>
      HttpResponse.json([
        { printer_id: PRINTER_ID, ams_id: 0, tray_id: 1, spool_id: 77, created_at: '2026-11-23T10:00:00' },
      ]),
    ),
    http.get('/api/v1/slot-spools/restorable', () => HttpResponse.json([])),
    http.post('/api/v1/slot-spools/prompts/:pid/:aid/:tid/same', ({ request }) => {
      sent.push({ method: 'POST', path: new URL(request.url).pathname });
      return HttpResponse.json({ status: 'ok', cleared: true });
    }),
  );
  render(<PrintersPage />);
  return sent;
}

/** The four slots in AMS order: a slot without a type is drawn as an empty-slot card. */
async function slots() {
  await waitFor(() =>
    expect(screen.queryAllByTestId(/^(filament|empty)-slot$/).length).toBe(4),
  );
  return screen.getAllByTestId(/^(filament|empty)-slot$/);
}

async function hover(slot: Element, action: string) {
  fireEvent.mouseEnter(slot);
  return screen.findByRole('button', { name: action });
}

describe('printer card slot spools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lights the new roll and the refilled slot only', async () => {
    setup();
    await slots();
    await waitFor(() => expect(screen.getAllByTestId('slot-spool-badge-check')).toHaveLength(1));
    expect(screen.getAllByTestId('slot-spool-badge-new')).toHaveLength(1);
  });

  it('"Same roll" answers the prompt for that slot', async () => {
    const user = userEvent.setup();
    const sent = setup();
    const all = await slots();
    await waitFor(() => expect(screen.getAllByTestId('slot-spool-badge-check')).toHaveLength(1));

    await user.click(await hover(all[1], 'Same roll'));

    await waitFor(() =>
      expect(sent).toEqual([{ method: 'POST', path: `/api/v1/slot-spools/prompts/${PRINTER_ID}/0/1/same` }]),
    );
  });

  it('"New roll…" opens the slot dialog asking how much is on the roll', async () => {
    const user = userEvent.setup();
    setup();
    const all = await slots();

    await user.click(await hover(all[0], 'New roll…'));

    expect(await screen.findByText('Roll in this slot')).toBeInTheDocument();
    expect(screen.getByText('Full roll – 1000 g')).toBeInTheDocument();
  });

  it('a counted slot spool offers to correct its amount', async () => {
    const user = userEvent.setup();
    setup();
    const all = await slots();

    await user.click(await hover(all[1], 'Correct the amount left'));

    expect(await screen.findByText('How many grams of filament are left on this roll?')).toBeInTheDocument();
    expect(screen.getByLabelText('Grams on the roll')).toHaveValue(650);
  });

  it('lights nothing in Spoolman mode', async () => {
    setup({ spoolman: true });
    await slots();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('slot-spool-badge-new')).toBeNull();
    expect(screen.queryByTestId('slot-spool-badge-check')).toBeNull();
  });
});
