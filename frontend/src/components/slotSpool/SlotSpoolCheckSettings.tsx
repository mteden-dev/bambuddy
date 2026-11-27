import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { parseGrams } from '../../utils/slotSpools';

interface SlotSpoolCheckSettingsProps {
  perSlot: boolean;
  marginPct: number;
  onPerSlotChange: (value: boolean) => void;
  onMarginChange: (value: number) => void;
}

/**
 * Fork (slot spools): how the filament check weighs a print, in Settings →
 * Filament checks. The backend reads the same two settings at dispatch, and
 * only with the built-in inventory: in Spoolman mode they do nothing, so they
 * say so and cannot be changed there.
 */
export function SlotSpoolCheckSettings({ perSlot, marginPct, onPerSlotChange, onMarginChange }: SlotSpoolCheckSettingsProps) {
  const { t } = useTranslation();
  // Shares the printers page's query (and its cache).
  const { data: spoolmanStatus } = useQuery({
    queryKey: ['spoolman-status'],
    queryFn: api.getSpoolmanStatus,
    staleTime: 60 * 1000,
  });
  const spoolman = !!spoolmanStatus?.enabled;
  // The margin as typed: the page saves every change after a moment, and a
  // field cleared to type a new value would otherwise be saved as 0 %.
  const [marginText, setMarginText] = useState(String(marginPct));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setMarginText(String(marginPct));
  }, [marginPct, editing]);

  const commitMargin = () => {
    setEditing(false);
    const parsed = parseGrams(marginText);
    if (parsed == null) {
      setMarginText(String(marginPct));
      return;
    }
    const value = Math.min(Math.max(Math.round(parsed), 0), 100);
    setMarginText(String(value));
    if (value !== marginPct) onMarginChange(value);
  };

  return (
    <>
      <p data-testid="slot-spool-check-builtin-only" className={`text-xs ${spoolman ? 'text-amber-400' : 'text-bambu-gray'}`}>
        {t(spoolman ? 'slotSpool.settings.spoolmanOff' : 'slotSpool.settings.builtinOnly')}
      </p>
      <div className={`flex items-center justify-between ${spoolman ? 'opacity-50' : ''}`}>
        <div>
          <p className="text-white">{t('slotSpool.settings.perSlot')}</p>
          <p className="text-sm text-bambu-gray">{t('slotSpool.settings.perSlotDesc')}</p>
        </div>
        <label className={`relative inline-flex items-center ${spoolman ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            aria-label={t('slotSpool.settings.perSlot')}
            checked={perSlot}
            disabled={spoolman}
            onChange={(e) => onPerSlotChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-bambu-dark-tertiary peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-bambu-green"></div>
        </label>
      </div>
      <div className={`flex items-center justify-between gap-4 ${spoolman ? 'opacity-50' : ''}`}>
        <div>
          <p className="text-white">{t('slotSpool.settings.margin')}</p>
          <p className="text-sm text-bambu-gray">{t('slotSpool.settings.marginDesc')}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <input
            type="text"
            inputMode="numeric"
            aria-label={t('slotSpool.settings.margin')}
            value={marginText}
            disabled={spoolman}
            onFocus={() => setEditing(true)}
            onChange={(e) => {
              setEditing(true);
              setMarginText(e.target.value);
            }}
            onBlur={commitMargin}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className="w-20 px-2 py-1.5 any-pointer-coarse:min-h-[44px] bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none disabled:cursor-not-allowed"
          />
          <span className="text-bambu-gray text-sm">%</span>
        </div>
      </div>
    </>
  );
}
