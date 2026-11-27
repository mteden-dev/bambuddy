/**
 * Hiding filament presets in the AMS slot picker (hidden_filament_presets /
 * hide_builtin_filament_presets settings).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { ConfigureAmsSlotModal } from '../../components/ConfigureAmsSlotModal';
import { api } from '../../api/client';

// The permissions the signed-in user holds; every test starts with both.
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
    getCloudSettings: vi.fn(),
    getKProfiles: vi.fn(),
    configureAmsSlot: vi.fn(),
    getCloudSettingDetail: vi.fn(),
    saveSlotPreset: vi.fn(),
    getSettings: vi.fn(),
    getUiSettings: vi.fn(),
    getSlicerPrinterModels: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    getLocalPresets: vi.fn(),
    getBuiltinFilaments: vi.fn(),
    orcaCloudListProfiles: vi.fn(),
    orcaCloudGetProfile: vi.fn(),
    searchColors: vi.fn(),
    getColorCatalog: vi.fn(),
    resetAmsSlot: vi.fn(),
    getPrinterStatus: vi.fn().mockResolvedValue({}),
  },
}));

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const CLOUD_PRESET = 'Bambu PLA Basic @BBL X1C';
const LOCAL_PRESET = 'My PETG';
const BUILTIN_PRESET = 'Bambu ABS';

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  printerId: 1,
  slotInfo: { amsId: 0, trayId: 0, trayType: 'PLA', trayColor: 'FFFFFF', traySubBrands: 'PLA Basic' },
  nozzleDiameter: '0.4',
  onSuccess: vi.fn(),
};

type HidingSettings = { hidden_filament_presets: string; hide_builtin_filament_presets: boolean };

// The settings as the server holds them: a save changes what the next read
// returns, since the modal refetches after saving.
let stored: HidingSettings;
function withSettings(settings: Partial<HidingSettings>) {
  stored = { hidden_filament_presets: '', hide_builtin_filament_presets: false, ...settings };
}

describe('ConfigureAmsSlotModal hidden presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.granted = new Set(['settings:read', 'settings:update']);
    mocked(api.getCloudSettings).mockResolvedValue({
      filament: [{ setting_id: 'GFSL05_09', name: CLOUD_PRESET, filament_id: 'GFL05' }],
    });
    mocked(api.getLocalPresets).mockResolvedValue({ filament: [{ id: 7, name: LOCAL_PRESET }] });
    mocked(api.getBuiltinFilaments).mockResolvedValue([{ filament_id: 'GFB00', name: BUILTIN_PRESET }]);
    mocked(api.getKProfiles).mockResolvedValue({ profiles: [] });
    mocked(api.orcaCloudListProfiles).mockResolvedValue({ filament: [], printer: [], process: [] });
    mocked(api.searchColors).mockResolvedValue([]);
    mocked(api.getColorCatalog).mockResolvedValue([]);
    withSettings({});
    mocked(api.getSettings).mockImplementation(async () => ({ ...stored }));
    mocked(api.updateSettings).mockImplementation(async (update) => {
      stored = { ...stored, ...update };
      return { ...stored };
    });
  });

  it('lists every preset when nothing is hidden', async () => {
    render(<ConfigureAmsSlotModal {...defaultProps} />);
    await waitFor(() => expect(screen.getByText(BUILTIN_PRESET)).toBeInTheDocument());
    expect(screen.getByText(CLOUD_PRESET)).toBeInTheDocument();
    expect(screen.getByText(LOCAL_PRESET)).toBeInTheDocument();
    expect(screen.queryByText(/Show hidden/)).not.toBeInTheDocument();
  });

  it('leaves hidden presets out until the user asks to see them', async () => {
    withSettings({ hidden_filament_presets: JSON.stringify(['GFSL05_09', 'local_7']) });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    await waitFor(() => expect(screen.getByText(BUILTIN_PRESET)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(CLOUD_PRESET)).not.toBeInTheDocument());
    expect(screen.queryByText(LOCAL_PRESET)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden (2)' }));
    expect(screen.getByText(CLOUD_PRESET)).toBeInTheDocument();
    expect(screen.getByText(LOCAL_PRESET)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Show this preset again: ${LOCAL_PRESET}` })).toBeInTheDocument();
  });

  it('does not bring back the built-in twin of a hidden cloud preset', async () => {
    // The built-in GFL05 is covered by the cloud preset GFSL05; hiding that
    // preset must not make the built-in fallback for the same filament appear.
    mocked(api.getCloudSettings).mockResolvedValue({
      filament: [{ setting_id: 'GFSL05', name: CLOUD_PRESET, filament_id: 'GFL05' }],
    });
    mocked(api.getBuiltinFilaments).mockResolvedValue([
      { filament_id: 'GFL05', name: 'Bambu PLA Basic' },
      { filament_id: 'GFB00', name: BUILTIN_PRESET },
    ]);
    withSettings({ hidden_filament_presets: JSON.stringify(['GFSL05']) });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    await waitFor(() => expect(screen.getByText(BUILTIN_PRESET)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(CLOUD_PRESET)).not.toBeInTheDocument());
    expect(screen.queryByText('Bambu PLA Basic')).not.toBeInTheDocument();
  });

  it('saves the preset ID when the user hides a preset', async () => {
    withSettings({ hidden_filament_presets: JSON.stringify(['local_7']) });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    const hide = await screen.findByRole('button', { name: `Hide this preset: ${BUILTIN_PRESET}` });
    fireEvent.click(hide);

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(mocked(api.updateSettings).mock.calls[0][0]).toEqual({
      hidden_filament_presets: JSON.stringify(['builtin_GFB00', 'local_7']),
    });
    await waitFor(() => expect(screen.queryByText(BUILTIN_PRESET)).not.toBeInTheDocument());
  });

  it('offers to undo hiding a preset, as one tap hides it for the whole install', async () => {
    withSettings({ hidden_filament_presets: JSON.stringify(['local_7']) });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    fireEvent.click(await screen.findByRole('button', { name: `Hide this preset: ${BUILTIN_PRESET}` }));
    expect(await screen.findByText(`Preset hidden: ${BUILTIN_PRESET}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
    expect(mocked(api.updateSettings).mock.calls[1][0]).toEqual({
      hidden_filament_presets: JSON.stringify(['local_7']),
    });
    expect(await screen.findByText(BUILTIN_PRESET)).toBeInTheDocument();
  });

  it('removes the ID when the user shows a hidden preset again', async () => {
    withSettings({ hidden_filament_presets: JSON.stringify(['local_7', 'GFSL05_09']) });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Show hidden (2)' }));
    fireEvent.click(screen.getByRole('button', { name: `Show this preset again: ${LOCAL_PRESET}` }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(mocked(api.updateSettings).mock.calls[0][0]).toEqual({
      hidden_filament_presets: JSON.stringify(['GFSL05_09']),
    });
  });

  it('hides the whole built-in tier with the checkbox', async () => {
    render(<ConfigureAmsSlotModal {...defaultProps} />);
    await waitFor(() => expect(screen.getByText(BUILTIN_PRESET)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide built-in presets' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ hide_builtin_filament_presets: true }));
    await waitFor(() => expect(screen.queryByText(BUILTIN_PRESET)).not.toBeInTheDocument());
    expect(screen.getByText(CLOUD_PRESET)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show hidden (1)' })).toBeInTheDocument();
  });

  it('keeps the slot preset listed, marked hidden, even when it is hidden', async () => {
    withSettings({ hidden_filament_presets: JSON.stringify(['local_7']) });
    render(
      <ConfigureAmsSlotModal
        {...defaultProps}
        slotInfo={{ ...defaultProps.slotInfo, savedPresetId: 'local_7' }}
      />,
    );

    expect(
      await screen.findByRole('button', { name: `Show this preset again: ${LOCAL_PRESET}` }),
    ).toBeInTheDocument();
    expect(screen.getByText(LOCAL_PRESET)).toBeInTheDocument();
    expect(screen.queryByText(/Show hidden/)).not.toBeInTheDocument();
  });

  it('marks the selected preset hidden at once when the user hides it', async () => {
    render(<ConfigureAmsSlotModal {...defaultProps} />);
    fireEvent.click(await screen.findByText(LOCAL_PRESET));
    const hide = screen.getByRole('button', { name: `Hide this preset: ${LOCAL_PRESET}` });
    await waitFor(() => expect(hide).not.toBeDisabled());
    fireEvent.click(hide);

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ hidden_filament_presets: JSON.stringify(['local_7']) }),
    );
    // Still listed, since it is the selected one, but now offering to undo.
    expect(
      await screen.findByRole('button', { name: `Show this preset again: ${LOCAL_PRESET}` }),
    ).toBeInTheDocument();
    expect(screen.getByText(LOCAL_PRESET)).toBeInTheDocument();
  });

  it('changes nothing before the hidden list has loaded', async () => {
    // Each change rewrites the whole list; one made before it loaded would
    // drop every preset hidden so far.
    mocked(api.getSettings).mockReturnValue(new Promise(() => {}));
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    expect(await screen.findByRole('button', { name: `Hide this preset: ${BUILTIN_PRESET}` })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Hide built-in presets' })).toBeDisabled();
  });

  it('applies the hidden list but offers no way to change it without settings:update', async () => {
    auth.granted = new Set(['settings:read']);
    withSettings({ hidden_filament_presets: JSON.stringify(['local_7']) });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    await waitFor(() => expect(screen.getByText(BUILTIN_PRESET)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(LOCAL_PRESET)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Hide this preset/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Hide built-in presets' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show hidden (1)' })).toBeInTheDocument();
  });

  it('reads the hidden list from the UI settings for a user without settings:read', async () => {
    auth.granted = new Set();
    mocked(api.getUiSettings).mockResolvedValue({
      hidden_filament_presets: JSON.stringify(['local_7']),
      hide_builtin_filament_presets: true,
    });
    render(<ConfigureAmsSlotModal {...defaultProps} />);

    await waitFor(() => expect(screen.getByText(CLOUD_PRESET)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(LOCAL_PRESET)).not.toBeInTheDocument());
    expect(screen.queryByText(BUILTIN_PRESET)).not.toBeInTheDocument();
    expect(api.getSettings).not.toHaveBeenCalled();
  });
});
