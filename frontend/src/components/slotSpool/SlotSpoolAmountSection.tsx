import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { getSwatchStyle } from '../../utils/colors';
import { formatDateOnly } from '../../utils/date';
import { FULL_ROLL_GRAMS, type SlotSpoolAmount } from '../../utils/slotSpools';

interface SlotSpoolAmountSectionProps {
  value: SlotSpoolAmount;
  onChange: (value: SlotSpoolAmount) => void;
  /** The slot's colour (6 or 8 hex), to list rolls of that colour first. */
  rgba?: string;
}

/**
 * Fork (slot spools): how much filament is on the roll going into the slot.
 * Shown in the slot dialog when it is opened to load a roll; saving the dialog
 * configures the slot and then starts counting on a slot spool.
 */
export function SlotSpoolAmountSection({ value, onChange, rgba }: SlotSpoolAmountSectionProps) {
  const { t } = useTranslation();
  const { data: restorable } = useQuery({
    queryKey: ['slot-spool-restorable', rgba ?? ''],
    queryFn: () => api.getRestorableSlotSpools(undefined, rgba || undefined),
    staleTime: 10_000,
  });

  const option = (selected: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
      selected
        ? 'border-bambu-green bg-bambu-green/10 text-white'
        : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-bambu-gray'
    }`;
  const dot = (selected: boolean) =>
    `w-3.5 h-3.5 shrink-0 rounded-full border-2 ${selected ? 'border-bambu-green bg-bambu-green' : 'border-bambu-gray'}`;

  return (
    <div className="space-y-2" data-testid="slot-spool-amount">
      <p className="text-sm font-medium text-white">{t('slotSpool.sectionTitle')}</p>

      <button type="button" className={option(value.kind === 'full')} onClick={() => onChange({ kind: 'full' })}>
        <span className={dot(value.kind === 'full')} />
        {t('slotSpool.full', { grams: FULL_ROLL_GRAMS })}
      </button>

      <div className={option(value.kind === 'grams')}>
        <button
          type="button"
          className="flex items-center gap-2 flex-1 text-left"
          onClick={() => onChange({ kind: 'grams', grams: value.kind === 'grams' ? value.grams : null })}
        >
          <span className={dot(value.kind === 'grams')} />
          {t('slotSpool.other')}
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={5000}
          step={1}
          aria-label={t('slotSpool.gramsLabel')}
          placeholder={t('slotSpool.gramsPlaceholder')}
          value={value.kind === 'grams' && value.grams != null ? value.grams : ''}
          onFocus={() => {
            if (value.kind !== 'grams') onChange({ kind: 'grams', grams: null });
          }}
          onChange={(e) => {
            const parsed = e.target.value === '' ? null : Number(e.target.value);
            onChange({ kind: 'grams', grams: parsed != null && Number.isFinite(parsed) ? parsed : null });
          }}
          className="w-24 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:border-bambu-green focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        <p className="text-xs text-bambu-gray pt-1">{t('slotSpool.restore')}</p>
        {restorable && restorable.length > 0 ? (
          restorable.map((roll) => {
            const selected = value.kind === 'restore' && value.spoolId === roll.id;
            return (
              <button
                key={roll.id}
                type="button"
                className={option(selected)}
                onClick={() => onChange({ kind: 'restore', spoolId: roll.id })}
              >
                <span className={dot(selected)} />
                <span
                  className="w-4 h-4 shrink-0 rounded-full border border-black/20"
                  style={getSwatchStyle(roll.rgba)}
                />
                <span className="flex-1 min-w-0 truncate">
                  {roll.slicer_filament_name || roll.material}
                  {roll.color_name ? ` · ${roll.color_name}` : ''}
                </span>
                <span className="shrink-0 text-xs">
                  {t('slotSpool.restoreItem', { grams: Math.round(roll.remaining_grams) })}
                  {roll.archived_at ? ` · ${t('slotSpool.takenOut', { date: formatDateOnly(roll.archived_at) })}` : ''}
                </span>
              </button>
            );
          })
        ) : (
          <p className="text-xs text-bambu-gray/70 px-1">{t('slotSpool.restoreEmpty')}</p>
        )}
      </div>

      <p className="text-xs text-bambu-gray">{t('slotSpool.hint')}</p>
    </div>
  );
}
