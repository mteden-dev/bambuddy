import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Archive } from 'lucide-react';
import { api, type RestorableSlotSpool } from '../../api/client';
import { getSwatchStyle } from '../../utils/colors';
import { formatDateOnly } from '../../utils/date';
import {
  FULL_ROLL_GRAMS,
  MAX_ROLL_GRAMS,
  parseGrams,
  rollGramsValid,
  type SlotSpoolAmount,
} from '../../utils/slotSpools';

/** Rolls listed before "show all"; one more is asked for to know there are more. */
export const RESTORE_PAGE = 10;
const RESTORE_ALL = 200;

/**
 * The restore list's query key. Under 'spool-assignments' on purpose: the
 * websocket's inventory and assignment events invalidate that prefix, so a roll
 * restored into another slot (or one just taken out) is never offered stale.
 */
const restorableQueryKey =(...parts: unknown[]) => ['spool-assignments', 'slot-spool-restorable', ...parts];

interface SlotSpoolAmountSectionProps {
  value: SlotSpoolAmount;
  onChange: (value: SlotSpoolAmount) => void;
  /** The slot's colour (6 or 8 hex), to list rolls of that colour first. */
  rgba?: string;
  /** The slot's type, to list rolls of that type first (the others under "other"). */
  material?: string;
  /** For the restored roll's K profile on this printer. */
  printerId?: number;
  /** A restore row was picked: the dialog sets the slot to that roll. */
  onRestorePick?: (roll: RestorableSlotSpool) => void;
  /** The preset or colour now differs from the picked roll's, which the save renames it to. */
  restoreRenames?: boolean;
  /** The spool the slot holds now, which loading a roll replaces. */
  replacesSpool?: { grams: number; slotSpool: boolean } | null;
}

/**
 * Fork (slot spools): how much filament is on the roll going into the slot.
 * Shown in the slot dialog when it is opened to load a roll; saving the dialog
 * configures the slot and then starts counting on a slot spool.
 */
export function SlotSpoolAmountSection({
  value,
  onChange,
  rgba,
  material,
  printerId,
  onRestorePick,
  restoreRenames = false,
  replacesSpool,
}: SlotSpoolAmountSectionProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  // What is typed, kept as typed: "6,5" or "65," is not a number yet, and a
  // number input would show such a value as empty with no word why.
  const [gramsText, setGramsText] = useState(value.kind === 'grams' && value.grams != null ? String(value.grams) : '');
  const colour = (rgba ?? '').replace('#', '').slice(0, 6).toUpperCase();
  const { data: restorable } = useQuery({
    queryKey: restorableQueryKey(material ?? '', colour, printerId ?? null, showAll),
    queryFn: () => api.getRestorableSlotSpools({
      material: material || undefined,
      rgba: colour || undefined,
      limit: showAll ? RESTORE_ALL : RESTORE_PAGE + 1,
      includeOther: true,
      printerId,
    }),
    staleTime: 10_000,
  });
  const hasMore = !showAll && (restorable?.length ?? 0) > RESTORE_PAGE;
  const shown = hasMore ? restorable!.slice(0, RESTORE_PAGE) : restorable ?? [];
  const matching = shown.filter((roll) => roll.material_match !== false);
  const others = shown.filter((roll) => roll.material_match === false);

  const gramsInvalid = value.kind === 'grams' && gramsText.trim() !== '' && !rollGramsValid(value.grams);

  const option = (selected: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 any-pointer-coarse:min-h-[44px] rounded-lg border text-left text-sm transition-colors ${
      selected
        ? 'border-bambu-green bg-bambu-green/10 text-white'
        : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-bambu-gray'
    }`;
  const dot = (selected: boolean) =>
    `w-3.5 h-3.5 shrink-0 rounded-full border-2 ${selected ? 'border-bambu-green bg-bambu-green' : 'border-bambu-gray'}`;

  const restoreRow = (roll: RestorableSlotSpool) => {
    const selected = value.kind === 'restore' && value.spoolId === roll.id;
    return (
      <button
        key={roll.id}
        type="button"
        className={option(selected)}
        onClick={() => {
          onChange({ kind: 'restore', spoolId: roll.id });
          onRestorePick?.(roll);
        }}
      >
        <span className={dot(selected)} />
        <span className="w-4 h-4 shrink-0 rounded-full border border-black/20" style={getSwatchStyle(roll.rgba)} />
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
  };

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
          onClick={() => onChange({ kind: 'grams', grams: value.kind === 'grams' ? value.grams : parseGrams(gramsText) })}
        >
          <span className={dot(value.kind === 'grams')} />
          {t('slotSpool.other')}
        </button>
        <input
          type="text"
          inputMode="decimal"
          aria-label={t('slotSpool.gramsLabel')}
          aria-invalid={gramsInvalid}
          placeholder={t('slotSpool.gramsPlaceholder')}
          value={gramsText}
          onFocus={() => {
            if (value.kind !== 'grams') onChange({ kind: 'grams', grams: parseGrams(gramsText) });
          }}
          onChange={(e) => {
            setGramsText(e.target.value);
            onChange({ kind: 'grams', grams: parseGrams(e.target.value) });
          }}
          className={`w-24 px-2 py-1 bg-bambu-dark border rounded text-white text-sm focus:outline-none ${
            gramsInvalid ? 'border-red-500 focus:border-red-500' : 'border-bambu-dark-tertiary focus:border-bambu-green'
          }`}
        />
      </div>
      {gramsInvalid && (
        <p role="alert" className="text-xs text-red-400 px-1">
          {t('slotSpool.gramsInvalid', { max: MAX_ROLL_GRAMS })}
        </p>
      )}

      <div className="space-y-1">
        <p className="text-xs text-bambu-gray pt-1">{t('slotSpool.restore')}</p>
        {shown.length > 0 ? (
          <>
            {matching.map(restoreRow)}
            {others.length > 0 && (
              <>
                <p className="text-xs text-bambu-gray/80 pt-1">{t('slotSpool.restoreOther')}</p>
                {others.map(restoreRow)}
              </>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs text-bambu-gray hover:text-white underline-offset-2 hover:underline px-1 any-pointer-coarse:min-h-[44px]"
              >
                {t('slotSpool.restoreShowAll')}
              </button>
            )}
          </>
        ) : (
          <p className="text-xs text-bambu-gray/70 px-1">{t('slotSpool.restoreEmpty')}</p>
        )}
        {value.kind === 'restore' && (
          restoreRenames ? (
            <p
              data-testid="slot-spool-restore-renames"
              className="flex gap-1.5 text-xs text-amber-300 px-1 pt-1"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              {t('slotSpool.restoreRenames')}
            </p>
          ) : (
            <p data-testid="slot-spool-restore-prefilled" className="text-xs text-bambu-green px-1 pt-1">
              {t('slotSpool.restorePrefilled')}
            </p>
          )
        )}
      </div>

      {replacesSpool && (
        <p data-testid="slot-spool-replaces" className="flex gap-1.5 text-xs text-bambu-gray">
          <Archive className="w-3.5 h-3.5 shrink-0 mt-px" />
          {t(replacesSpool.slotSpool ? 'slotSpool.replacesSlotSpool' : 'slotSpool.replacesSpool', {
            grams: Math.round(replacesSpool.grams),
          })}
        </p>
      )}

      <p className="text-xs text-bambu-gray">{t('slotSpool.hint')}</p>
    </div>
  );
}
