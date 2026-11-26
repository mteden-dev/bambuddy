/**
 * Fork (filament aliases): the Settings card that marks colours and filament
 * profiles as the same, picked from what the printers and the queue show.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FilamentAliasesCard } from '../../components/filamentAliases/FilamentAliasesCard';
import { aliasPreset, setFilamentAliases } from '../../utils/filamentAliases';

const SEEN = {
  seen_colors: [
    { color: 'dcdb4e', types: ['PETG'], where: ['queue'] },
    { color: 'e2df60', types: ['PETG'], where: ['002', 'H2S'] },
  ],
  seen_presets: [
    { preset: 'GFG99', types: ['PETG'], names: [], where: ['queue'] },
    { preset: 'P1a2b3c4', types: ['PETG'], names: ['My PETG'], where: ['003'] },
  ],
};

describe('FilamentAliasesCard', () => {
  afterEach(() => setFilamentAliases(null));

  it('makes a profile group from what the printers and the queue show, and saves it', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('/api/v1/filament-aliases', () => HttpResponse.json({ colors: [], presets: [], ...SEEN })),
      http.put('/api/v1/filament-aliases', async ({ request }) => {
        const body = (await request.json()) as { colors: string[][]; presets: string[][] };
        saved.push(body);
        return HttpResponse.json({ ...body, ...SEEN });
      }),
    );
    const user = userEvent.setup();
    render(<FilamentAliasesCard />);

    await user.click(await screen.findByRole('button', { name: /New profile group/ }));
    const add = screen.getByRole('combobox', { name: 'Add a profile…' });
    expect(screen.getByRole('option', { name: /P1a2b3c4 · My PETG · PETG · 003/ })).toBeInTheDocument();
    await user.selectOptions(add, 'GFG99');
    expect(screen.getByText(/one alone is not saved/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a profile…' }), 'P1a2b3c4');
    expect(screen.queryByText(/one alone is not saved/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toEqual([{ colors: [], presets: [['GFG99', 'P1a2b3c4']] }]));
    // The hints go by it at once.
    expect(aliasPreset('P1a2b3c4')).toBe('GFG99');
  });

  it('takes a colour typed by hand and refuses one that is not a colour', async () => {
    server.use(
      http.get('/api/v1/filament-aliases', () =>
        HttpResponse.json({ colors: [['dcdb4e', 'e2df60']], presets: [], ...SEEN }),
      ),
    );
    const user = userEvent.setup();
    render(<FilamentAliasesCard />);

    expect(await screen.findByText('#DCDB4E')).toBeInTheDocument();
    expect(screen.getByText('#E2DF60')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a colour…' }), '__other__');
    const input = screen.getByRole('textbox', { name: 'Add a colour…' });
    await user.type(input, 'nope{Enter}');
    expect(screen.getByText(/six hex digits/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '#f0e68c{Enter}');
    expect(screen.getByText('#F0E68C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
