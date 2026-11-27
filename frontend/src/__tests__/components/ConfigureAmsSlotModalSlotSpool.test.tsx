/**
 * Fork (slot spools): the slot dialog opened to load a roll asks how much is on
 * it and, once the slot is configured, starts counting on a slot spool that
 * describes the slot exactly as it was just configured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { ConfigureAmsSlotModal } from '../../components/ConfigureAmsSlotModal';
import { api } from '../../api/client';

vi.mock('../../api/client', () => ({
  api: {
    getCloudSettings: vi.fn(),
    getKProfiles: vi.fn(),
    configureAmsSlot: vi.fn(),
    getCloudSettingDetail: vi.fn(),
    saveSlotPreset: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getSlicerPrinterModels: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    getLocalPresets: vi.fn(),
    getBuiltinFilaments: vi.fn(),
    orcaCloudListProfiles: vi.fn(),
    orcaCloudGetProfile: vi.fn(),
    searchColors: vi.fn(),
    getColorCatalog: vi.fn(),
    resetAmsSlot: vi.fn(),
    getPrinterStatus: vi.fn().mockResolvedValue({}),
    loadSlotSpool: vi.fn(),
    getRestorableSlotSpools: vi.fn(),
  },
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const props = {
  isOpen: true,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
  printerId: 3,
  slotInfo: {
    amsId: 1,
    trayId: 2,
    trayType: 'PLA',
    trayColor: '112233FF',
    savedPresetId: 'GFSL05_09',
  },
  nozzleDiameter: '0.4',
};

async function openWithPreset(trackSlotSpool = true, extra: Record<string, unknown> = {}) {
  render(<ConfigureAmsSlotModal {...props} trackSlotSpool={trackSlotSpool} {...extra} />);
  await waitFor(() => {
    expect(screen.getByText('Bambu PLA Basic @BBL X1C')).toBeInTheDocument();
  });
}

function configureButton() {
  return screen.getByRole('button', { name: /Configure Slot/i });
}

const roll = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  material: 'PLA',
  color_name: null,
  rgba: '112233FF',
  slicer_filament: 'GFSL05_09',
  slicer_filament_name: `Roll ${id}`,
  remaining_grams: 300 + id,
  label_weight: 1000,
  archived_at: '2026-11-20T10:00:00',
  material_match: true,
  k_profiles: [],
  ...extra,
});

describe('ConfigureAmsSlotModal loading a slot spool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mocked.getPrinterStatus.mockResolvedValue({});
    mocked.getSettings.mockResolvedValue({});
    mocked.getSlicerPrinterModels.mockResolvedValue({});
    mocked.getCloudSettings.mockResolvedValue({
      filament: [{ setting_id: 'GFSL05_09', name: 'Bambu PLA Basic @BBL X1C', filament_id: 'GFL05' }],
    });
    mocked.getKProfiles.mockResolvedValue({ profiles: [] });
    mocked.configureAmsSlot.mockResolvedValue({ success: true, tray_info_idx: 'GFL05' });
    mocked.saveSlotPreset.mockResolvedValue({ success: true });
    mocked.getLocalPresets.mockResolvedValue({ filament: [] });
    mocked.orcaCloudListProfiles.mockResolvedValue({ filament: [], printer: [], process: [] });
    mocked.getBuiltinFilaments.mockResolvedValue([]);
    mocked.searchColors.mockResolvedValue([]);
    mocked.getColorCatalog.mockResolvedValue([]);
    mocked.loadSlotSpool.mockResolvedValue({ id: 1 });
    mocked.getRestorableSlotSpools.mockResolvedValue([
      {
        id: 41,
        material: 'PLA',
        color_name: null,
        rgba: '112233FF',
        slicer_filament_name: 'Generic PLA',
        remaining_grams: 420,
        label_weight: 1000,
        archived_at: '2026-11-20T10:00:00',
      },
    ]);
  });

  it('counts a full roll after configuring the slot', async () => {
    await openWithPreset();
    expect(screen.getByTestId('slot-spool-amount')).toBeInTheDocument();

    fireEvent.click(configureButton());

    await waitFor(() => expect(mocked.loadSlotSpool).toHaveBeenCalled());
    expect(mocked.configureAmsSlot).toHaveBeenCalled();
    expect(mocked.configureAmsSlot.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.loadSlotSpool.mock.invocationCallOrder[0],
    );
    const sent = mocked.configureAmsSlot.mock.calls[0][3];
    expect(mocked.loadSlotSpool).toHaveBeenCalledWith(
      expect.objectContaining({
        printer_id: 3,
        ams_id: 1,
        tray_id: 2,
        // The slot's own type and colour, as just sent to the printer.
        material: sent.tray_type,
        rgba: sent.tray_color,
        slicer_filament: 'GFSL05_09',
        slicer_filament_name: 'Bambu PLA Basic @BBL X1C',
        remaining_grams: 1000,
        restore_spool_id: null,
        k_profile: null,
      }),
    );
  });

  it('counts another amount, and will not save without one', async () => {
    await openWithPreset();

    fireEvent.click(screen.getByText('Other amount (g)'));
    expect(configureButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Grams on the roll'), { target: { value: '420' } });
    expect(configureButton()).not.toBeDisabled();
    fireEvent.click(configureButton());

    await waitFor(() => expect(mocked.loadSlotSpool).toHaveBeenCalled());
    expect(mocked.loadSlotSpool.mock.calls[0][0]).toMatchObject({ remaining_grams: 420, restore_spool_id: null });
  });

  it('puts back a roll taken out earlier', async () => {
    await openWithPreset();

    fireEvent.click(await screen.findByText('Generic PLA'));
    fireEvent.click(configureButton());

    await waitFor(() => expect(mocked.loadSlotSpool).toHaveBeenCalled());
    expect(mocked.loadSlotSpool.mock.calls[0][0]).toMatchObject({ remaining_grams: null, restore_spool_id: 41 });
    // The slot's type goes with the request, the other types listed after it.
    expect(mocked.getRestorableSlotSpools).toHaveBeenCalledWith(
      expect.objectContaining({ material: 'PLA', rgba: '112233', includeOther: true, printerId: 3, limit: 11 }),
    );
  });

  it('only configures the slot when not opened to load a roll', async () => {
    await openWithPreset(false);
    expect(screen.queryByTestId('slot-spool-amount')).not.toBeInTheDocument();

    fireEvent.click(configureButton());

    await waitFor(() => expect(mocked.configureAmsSlot).toHaveBeenCalled());
    expect(mocked.loadSlotSpool).not.toHaveBeenCalled();
  });

  it('shows the amount it will record on the save button, and puts the amount first', async () => {
    await openWithPreset();
    expect(configureButton()).toHaveTextContent('Configure Slot · 1000 g');
    const amount = screen.getByTestId('slot-spool-amount');
    const presets = screen.getByText('Bambu PLA Basic @BBL X1C');
    // Not at the bottom of the scroll, under the preset list.
    expect(amount.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByText('Other amount (g)'));
    fireEvent.change(screen.getByLabelText('Grams on the roll'), { target: { value: '430' } });
    expect(configureButton()).toHaveTextContent('Configure Slot · 430 g');
  });

  it('refuses 0 g and more than 5 kg, and takes a decimal comma', async () => {
    await openWithPreset();
    fireEvent.click(screen.getByText('Other amount (g)'));
    const input = screen.getByLabelText('Grams on the roll');
    expect(input).toHaveAttribute('inputmode', 'decimal');

    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter 1 to 5000 g.');
    expect(configureButton()).toBeDisabled();

    fireEvent.change(input, { target: { value: '6500' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(configureButton()).toBeDisabled();

    fireEvent.change(input, { target: { value: '412,5' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(configureButton());
    await waitFor(() => expect(mocked.loadSlotSpool).toHaveBeenCalled());
    expect(mocked.loadSlotSpool.mock.calls[0][0]).toMatchObject({ remaining_grams: 412.5 });
  });

  it('says what happens to the roll the slot holds now', async () => {
    await openWithPreset(true, { replacesSpool: { grams: 430, slotSpool: true } });
    expect(screen.getByTestId('slot-spool-replaces')).toHaveTextContent(
      'The current roll (430 g) goes to the archive; it can be put back later.',
    );
  });

  it('sets the slot to the restored roll', async () => {
    mocked.getCloudSettings.mockResolvedValue({
      filament: [
        { setting_id: 'GFSL05_09', name: 'Bambu PLA Basic @BBL X1C', filament_id: 'GFL05' },
        { setting_id: 'GFSG99_09', name: 'Generic PETG @BBL X1C', filament_id: 'GFG99' },
      ],
    });
    mocked.getKProfiles.mockResolvedValue({
      profiles: [
        { slot_id: 5, extruder_id: 0, nozzle_diameter: '0.4', name: 'Red PETG', k_value: '0.031', filament_id: 'GFG99', setting_id: '' },
      ],
    });
    mocked.getRestorableSlotSpools.mockResolvedValue([
      roll(52, {
        material: 'PETG',
        rgba: 'CC0000FF',
        color_name: 'Signal red',
        slicer_filament: 'GFSG99_09',
        slicer_filament_name: 'Generic PETG',
        material_match: false,
        k_profiles: [{ printer_id: 3, extruder: 0, nozzle_diameter: '0.4', cali_idx: 5, k_value: 0.031, name: 'Red PETG', setting_id: null }],
      }),
    ]);
    await openWithPreset();

    // Another type than the slot's: listed apart.
    expect(await screen.findByText('Other types')).toBeInTheDocument();
    fireEvent.click(await screen.findByText(/Generic PETG · Signal red/));

    expect(screen.getByTestId('slot-spool-restore-prefilled')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Signal red')).toBeInTheDocument();
    fireEvent.click(configureButton());
    await waitFor(() => expect(mocked.loadSlotSpool).toHaveBeenCalled());
    const sent = mocked.configureAmsSlot.mock.calls[0][3];
    expect(sent).toMatchObject({ tray_color: 'CC0000FF', setting_id: 'GFSG99_09', cali_idx: 5 });
    expect(mocked.loadSlotSpool.mock.calls[0][0]).toMatchObject({
      restore_spool_id: 52,
      slicer_filament: 'GFSG99_09',
      rgba: 'CC0000FF',
      color_name: 'Signal red',
    });
  });

  it('warns that a restored roll will be renamed when its preset is changed', async () => {
    mocked.getCloudSettings.mockResolvedValue({
      filament: [
        { setting_id: 'GFSL05_09', name: 'Bambu PLA Basic @BBL X1C', filament_id: 'GFL05' },
        { setting_id: 'GFSG99_09', name: 'Generic PETG @BBL X1C', filament_id: 'GFG99' },
      ],
    });
    mocked.getRestorableSlotSpools.mockResolvedValue([roll(41)]);
    await openWithPreset();
    fireEvent.click(await screen.findByText('Roll 41'));
    expect(screen.queryByTestId('slot-spool-restore-renames')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Generic PETG @BBL X1C'));
    expect(screen.getByTestId('slot-spool-restore-renames')).toBeInTheDocument();
  });

  it('shows more than the first ten rolls on request', async () => {
    mocked.getRestorableSlotSpools.mockImplementation(async ({ limit }: { limit: number }) =>
      Array.from({ length: Math.min(limit, 14) }, (_, i) => roll(100 + i)),
    );
    await openWithPreset();
    expect(await screen.findByText('Roll 109')).toBeInTheDocument();
    expect(screen.queryByText('Roll 110')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(await screen.findByText('Roll 113')).toBeInTheDocument();
    expect(mocked.getRestorableSlotSpools).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 }));
  });
});
