/**
 * The AMS slot picker's editable quick colours (ams_color_palette setting).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from '../utils';
import { AmsColorPalette } from '../../components/AmsColorPalette';
import { api } from '../../api/client';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), hasPermission: (p: string) => auth.granted.has(p) }),
  };
});

vi.mock('../../api/client', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function renderPalette(props: Partial<Parameters<typeof AmsColorPalette>[0]> = {}) {
  const onPick = vi.fn();
  render(<AmsColorPalette selectedHex="" onPick={onPick} {...props} />);
  return { onPick };
}

async function openEditor() {
  const edit = await screen.findByRole('button', { name: 'Edit colors' });
  await waitFor(() => expect(edit).not.toBeDisabled());
  fireEvent.click(edit);
}

let stored: { ams_color_palette: string };

describe('AmsColorPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.granted = new Set(['settings:read', 'settings:update']);
    // The settings as the server holds them: a save changes what the next
    // read returns, since the palette refetches after saving.
    stored = { ams_color_palette: '' };
    mocked(api.getSettings).mockImplementation(async () => ({ ...stored }));
    mocked(api.updateSettings).mockImplementation(async (update) => {
      stored = { ...stored, ...update };
      return { ...stored };
    });
  });

  it('shows the default colours with the rest behind the + button', async () => {
    renderPalette();
    expect(await screen.findByTitle('White')).toBeInTheDocument();
    expect(screen.queryByTitle('Cyan')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show more colors'));
    expect(screen.getByTitle('Cyan')).toBeInTheDocument();
  });

  it('offers no editor without settings:update', async () => {
    auth.granted = new Set(['settings:read']);
    renderPalette();
    expect(await screen.findByTitle('White')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit colors' })).not.toBeInTheDocument();
  });

  it('shows the hovered colour name and hex', async () => {
    renderPalette();
    fireEvent.mouseEnter(await screen.findByTitle('Orange'));
    expect(screen.getByText('#FFA500')).toBeInTheDocument();
  });

  it('picks a colour by name and hex', async () => {
    const { onPick } = renderPalette();
    fireEvent.click(await screen.findByTitle('Red'));
    expect(onPick).toHaveBeenCalledWith('Red', 'FF0000');
  });

  it('uses a stored palette in its order, without a + button when nothing is hidden', async () => {
    stored = {
      ams_color_palette: JSON.stringify([
        { name: 'Bambu Green', hex: '00AE42' },
        { name: 'Jade White', hex: 'FFFFFF' },
      ]),
    };
    renderPalette();
    await screen.findByTitle('Bambu Green');
    const names = screen.getAllByRole('button', { name: /#[0-9A-F]{6}$/ }).map((b) => b.getAttribute('title'));
    expect(names).toEqual(['Bambu Green', 'Jade White']);
    expect(screen.queryByTitle('Show more colors')).not.toBeInTheDocument();
  });

  it('adds the current colour, reorders, hides and saves the palette', async () => {
    stored = {
      ams_color_palette: JSON.stringify([
        { name: 'White', hex: 'FFFFFF' },
        { name: 'Black', hex: '000000' },
      ]),
    };
    renderPalette({ selectedHex: '5A189A', suggestedName: 'Matte Purple' });

    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add color' }));
    expect(screen.getByDisplayValue('Matte Purple')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5A189A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move up: Matte Purple' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide behind the + button: White' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save colors' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(JSON.parse(mocked(api.updateSettings).mock.calls[0][0].ams_color_palette)).toEqual([
      { name: 'White', hex: 'FFFFFF', hidden: true },
      { name: 'Matte Purple', hex: '5A189A' },
      { name: 'Black', hex: '000000' },
    ]);
    // Back to the swatches, with the saved order.
    expect(await screen.findByTitle('Matte Purple')).toBeInTheDocument();
    expect(screen.queryByTitle('White')).not.toBeInTheDocument();
  });

  it('removes a colour and edits a hex by hand', async () => {
    stored = {
      ams_color_palette: JSON.stringify([
        { name: 'White', hex: 'FFFFFF' },
        { name: 'Black', hex: '000000' },
      ]),
    };
    renderPalette();
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove color: Black' }));
    fireEvent.change(screen.getByDisplayValue('FFFFFF'), { target: { value: '#f5f5f0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save colors' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(mocked(api.updateSettings).mock.calls[0][0]).toEqual({
      ams_color_palette: '[{"name":"White","hex":"F5F5F0"}]',
    });
  });

  it('does not open the editor before the stored palette has loaded', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocked(api.getSettings).mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPalette();
    const edit = await screen.findByRole('button', { name: 'Edit colors' });
    expect(edit).toBeDisabled();
    resolve({ ams_color_palette: JSON.stringify([{ name: 'Stored', hex: '123456' }]) });
    await waitFor(() => expect(edit).not.toBeDisabled());
  });

  it('will not save an invalid hex', async () => {
    renderPalette();
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('FFFFFF'), { target: { value: 'FFF0' } });
    expect(screen.getByRole('button', { name: 'Save colors' })).toBeDisabled();
  });

  it('restores the defaults, which store as empty', async () => {
    stored = {
      ams_color_palette: JSON.stringify([{ name: 'Only', hex: '123456' }]),
    };
    renderPalette();
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    const list = screen.getByDisplayValue('White').closest('div.max-h-64') as HTMLElement;
    expect(within(list).getAllByLabelText('Color name')).toHaveLength(32);
    fireEvent.click(screen.getByRole('button', { name: 'Save colors' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ ams_color_palette: '' }));
  });

  it('discards edits on cancel', async () => {
    renderPalette();
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove color: White' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTitle('White')).toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});
