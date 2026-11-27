/**
 * Fork: "Always ask for the colors in the file" (services/file_colors), a
 * switch in the Filament tab, off until someone turns it on.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { SettingsPage } from '../../pages/SettingsPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

const settings: Record<string, unknown> = {
  auto_archive: true,
  currency: 'USD',
  time_format: 'system',
  date_format: 'system',
  check_updates: false,
  check_printer_firmware: false,
  external_url: window.location.origin,
};

let saved: Array<Record<string, unknown>>;

function serve(current: Record<string, unknown>) {
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json(current)),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saved.push(body);
      return HttpResponse.json({ ...current, ...body });
    }),
    http.get('/api/v1/filament-aliases', () =>
      HttpResponse.json({ colors: [], presets: [], seen_colors: [], seen_presets: [] }),
    ),
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/notifications/', () => HttpResponse.json([])),
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?tab=filament');
  vi.mocked(localStorage.getItem).mockReset();
  setAuthToken(null);
  saved = [];
});

async function toggle() {
  const el = (await screen.findByLabelText('Always ask for the colors in the file')) as HTMLInputElement;
  // Let the loaded settings land first; a change before that is overwritten.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return el;
}

describe('SettingsPage - always ask for the colors in the file (fork)', () => {
  it('is off when nothing is set', async () => {
    serve(settings);
    render(<SettingsPage />);

    expect((await toggle()).checked).toBe(false);
  });

  it('shows it on when saved on', async () => {
    serve({ ...settings, require_file_colors: true });
    render(<SettingsPage />);

    await waitFor(async () => expect((await toggle()).checked).toBe(true));
  });

  it('saves it when switched on', async () => {
    serve(settings);
    render(<SettingsPage />);

    fireEvent.click(await toggle());

    await waitFor(() => expect(saved.at(-1)?.require_file_colors).toBe(true), { timeout: 3000 });
  });
});
