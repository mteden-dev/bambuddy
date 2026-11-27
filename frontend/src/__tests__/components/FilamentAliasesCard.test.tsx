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
    // A group of one is never sent.
    await new Promise((r) => setTimeout(r, 700));
    expect(saved).toEqual([]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a profile…' }), 'P1a2b3c4');
    expect(screen.queryByText(/one alone is not saved/)).not.toBeInTheDocument();

    // Saved by itself a moment later, like the rest of Settings.
    await waitFor(() => expect(saved).toEqual([{ colors: [], presets: [['GFG99', 'P1a2b3c4']] }]));
    expect(await screen.findByTestId('filament-aliases-status')).toHaveTextContent('Saved');
    // The hints go by it at once.
    expect(aliasPreset('P1a2b3c4')).toBe('GFG99');
  });

  it('takes a colour typed by hand and refuses one that is not a colour', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get('/api/v1/filament-aliases', () =>
        HttpResponse.json({ colors: [['dcdb4e', 'e2df60']], presets: [], ...SEEN }),
      ),
      http.put('/api/v1/filament-aliases', async ({ request }) => {
        const body = (await request.json()) as { colors: string[][]; presets: string[][] };
        saved.push(body);
        return HttpResponse.json({ ...body, ...SEEN });
      }),
    );
    const user = userEvent.setup();
    render(<FilamentAliasesCard />);

    expect(await screen.findByText('#DCDB4E')).toBeInTheDocument();
    expect(screen.getByText('#E2DF60')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a colour…' }));
    await user.click(screen.getByRole('option', { name: 'Type another…' }));
    const input = screen.getByRole('textbox', { name: 'Add a colour…' });
    await user.type(input, 'nope{Enter}');
    expect(screen.getByText(/six hex digits/)).toBeInTheDocument();
    await user.clear(input);
    // A colour typed whole shows its square before it is added.
    await user.type(input, '#f0e68c');
    expect(screen.getAllByTestId('color-square').at(-1)).toHaveStyle({ backgroundColor: '#f0e68c' });
    await user.type(input, '{Enter}');
    expect(screen.getByText('#F0E68C')).toBeInTheDocument();
    await waitFor(() => expect(saved).toEqual([{ colors: [['dcdb4e', 'e2df60', 'f0e68c']], presets: [] }]));
  });

  it('takes the short three-digit form, as the colour palette does', async () => {
    server.use(
      http.get('/api/v1/filament-aliases', () =>
        HttpResponse.json({ colors: [['dcdb4e', 'e2df60']], presets: [], ...SEEN }),
      ),
      http.put('/api/v1/filament-aliases', async ({ request }) => HttpResponse.json({ ...((await request.json()) as object), ...SEEN })),
    );
    const user = userEvent.setup();
    render(<FilamentAliasesCard />);
    await screen.findByText('#DCDB4E');
    await user.click(screen.getByRole('button', { name: 'Add a colour…' }));
    await user.click(screen.getByRole('option', { name: 'Type another…' }));
    await user.type(screen.getByRole('textbox', { name: 'Add a colour…' }), '#f80{Enter}');
    expect(screen.getByText('#FF8800')).toBeInTheDocument();
  });

  it('keeps a half-typed field with its own group when a group above is removed', async () => {
    server.use(
      http.get('/api/v1/filament-aliases', () =>
        HttpResponse.json({ colors: [['dcdb4e', 'e2df60'], ['111111', '222222']], presets: [], ...SEEN }),
      ),
      http.put('/api/v1/filament-aliases', async ({ request }) => HttpResponse.json({ ...((await request.json()) as object), ...SEEN })),
    );
    const user = userEvent.setup();
    render(<FilamentAliasesCard />);
    await screen.findByText('#111111');
    // Start typing in the second group.
    await user.click(screen.getAllByRole('button', { name: 'Add a colour…' })[1]);
    await user.click(screen.getByRole('option', { name: 'Type another…' }));
    await user.type(screen.getByRole('textbox', { name: 'Add a colour…' }), '#333333');

    await user.click(screen.getAllByRole('button', { name: 'Remove group' })[0]);

    expect(screen.queryByText('#DCDB4E')).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Add a colour…' });
    expect(input).toHaveValue('#333333');
    expect(input.closest('div.rounded-lg.border')).toHaveTextContent('#111111');
  });

  it('shows each colour it offers as a square of that colour, not a hex code alone', async () => {
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

    await user.click(await screen.findByRole('button', { name: /New colour group/ }));
    expect(screen.queryByRole('combobox', { name: 'Add a colour…' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a colour…' }));
    const offered = screen.getByRole('option', { name: /#E2DF60 · PETG · 002, H2S/ });
    expect(offered.querySelector('[data-testid="color-square"]')).toHaveStyle({ backgroundColor: '#e2df60' });
    await user.click(offered);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a colour…' }));
    // What the group has is not offered again.
    expect(screen.queryByRole('option', { name: /#E2DF60/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /#DCDB4E · PETG · Queue/i }));

    await waitFor(() => expect(saved).toEqual([{ colors: [['e2df60', 'dcdb4e']], presets: [] }]));
  });
});
