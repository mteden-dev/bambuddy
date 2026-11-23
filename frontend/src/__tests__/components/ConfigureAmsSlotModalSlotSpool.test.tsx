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

async function openWithPreset(trackSlotSpool = true) {
  render(<ConfigureAmsSlotModal {...props} trackSlotSpool={trackSlotSpool} />);
  await waitFor(() => {
    expect(screen.getByText('Bambu PLA Basic @BBL X1C')).toBeInTheDocument();
  });
}

function configureButton() {
  return screen.getByRole('button', { name: /Configure Slot/i });
}

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
    expect(mocked.getRestorableSlotSpools).toHaveBeenCalledWith(undefined, '112233FF');
  });

  it('only configures the slot when not opened to load a roll', async () => {
    await openWithPreset(false);
    expect(screen.queryByTestId('slot-spool-amount')).not.toBeInTheDocument();

    fireEvent.click(configureButton());

    await waitFor(() => expect(mocked.configureAmsSlot).toHaveBeenCalled());
    expect(mocked.loadSlotSpool).not.toHaveBeenCalled();
  });
});
