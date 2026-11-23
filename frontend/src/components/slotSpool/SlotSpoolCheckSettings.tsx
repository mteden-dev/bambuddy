import { useTranslation } from 'react-i18next';

interface SlotSpoolCheckSettingsProps {
  perSlot: boolean;
  marginPct: number;
  onPerSlotChange: (value: boolean) => void;
  onMarginChange: (value: number) => void;
}

/**
 * Fork (slot spools): how the filament check weighs a print, in Settings →
 * Filament checks. The backend reads the same two settings at dispatch.
 */
export function SlotSpoolCheckSettings({ perSlot, marginPct, onPerSlotChange, onMarginChange }: SlotSpoolCheckSettingsProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white">{t('slotSpool.settings.perSlot')}</p>
          <p className="text-sm text-bambu-gray">{t('slotSpool.settings.perSlotDesc')}</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            aria-label={t('slotSpool.settings.perSlot')}
            checked={perSlot}
            onChange={(e) => onPerSlotChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-bambu-dark-tertiary peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-bambu-green"></div>
        </label>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-white">{t('slotSpool.settings.margin')}</p>
          <p className="text-sm text-bambu-gray">{t('slotSpool.settings.marginDesc')}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            aria-label={t('slotSpool.settings.margin')}
            value={marginPct}
            onChange={(e) => {
              const value = Math.round(Number(e.target.value));
              onMarginChange(Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0);
            }}
            className="w-20 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
          />
          <span className="text-bambu-gray text-sm">%</span>
        </div>
      </div>
    </>
  );
}
