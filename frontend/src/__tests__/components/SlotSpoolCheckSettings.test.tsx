/**
 * Fork (slot spools): the filament check's per-slot and margin settings. They
 * work with the built-in inventory only, and the margin is saved when the
 * field is left, not on every keystroke (a cleared field is not 0 %).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { SlotSpoolCheckSettings } from '../../components/slotSpool/SlotSpoolCheckSettings';

function setup(spoolman = false) {
  server.use(
    http.get('/api/v1/spoolman/status', () => HttpResponse.json({ enabled: spoolman, connected: spoolman, url: null })),
  );
  const onMarginChange = vi.fn();
  const onPerSlotChange = vi.fn();
  render(
    <SlotSpoolCheckSettings perSlot marginPct={5} onPerSlotChange={onPerSlotChange} onMarginChange={onMarginChange} />,
  );
  return { onMarginChange, onPerSlotChange };
}

describe('SlotSpoolCheckSettings', () => {
  it('says it is for the built-in inventory only', async () => {
    setup();
    expect(await screen.findByText('Built-in inventory only (not Spoolman).')).toBeInTheDocument();
    expect(screen.getByLabelText('Check each slot on its own')).toBeEnabled();
  });

  it('cannot be changed in Spoolman mode, and says why', async () => {
    setup(true);
    expect(await screen.findByText('Built-in inventory only: off while Spoolman mode is on.')).toBeInTheDocument();
    expect(screen.getByLabelText('Check each slot on its own')).toBeDisabled();
    expect(screen.getByLabelText('Filament margin')).toBeDisabled();
  });

  it('does not save a cleared margin as 0 %', async () => {
    const user = userEvent.setup();
    const { onMarginChange } = setup();
    const input = screen.getByLabelText('Filament margin');

    await user.clear(input);
    expect(onMarginChange).not.toHaveBeenCalled();
    await user.tab();

    expect(onMarginChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('5');
  });

  it('saves the typed margin when the field is left', async () => {
    const user = userEvent.setup();
    const { onMarginChange } = setup();
    const input = screen.getByLabelText('Filament margin');

    await user.clear(input);
    await user.type(input, '12');
    expect(onMarginChange).not.toHaveBeenCalled();
    await user.tab();

    await waitFor(() => expect(onMarginChange).toHaveBeenCalledWith(12));
    expect(onMarginChange).toHaveBeenCalledTimes(1);
  });
});
