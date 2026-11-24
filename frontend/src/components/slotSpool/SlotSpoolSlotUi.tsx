import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleHelp, PackagePlus, Scale, Undo2 } from 'lucide-react';
import { api, type InventorySpool } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { ConfirmModal } from '../ConfirmModal';
import type { SlotSpoolState } from '../../utils/slotSpools';

/**
 * Fork (slot spools): the printer card's side of a roll counted per AMS slot.
 * The rules for which slot lights up are in utils/slotSpools, the data hooks in
 * hooks/useSlotSpools.
 */

/** "NEW" / "?" chip in the corner of a lit slot. */
export function SlotSpoolBadge({ state }: { state: SlotSpoolState }) {
  const { t } = useTranslation();
  if (!state) return null;
  const isNew = state === 'new';
  return (
    <span
      data-testid={`slot-spool-badge-${state}`}
      title={t(isNew ? 'slotSpool.newTitle' : 'slotSpool.checkTitle')}
      className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 px-1 py-px text-[length:var(--pc-t8,8px)] font-bold rounded pointer-events-none leading-none z-10 ${
        isNew ? 'bg-sky-400 text-bambu-dark' : 'bg-amber-400 text-bambu-dark'
      }`}
    >
      {t(isNew ? 'slotSpool.badgeNew' : 'slotSpool.badgeCheck')}
    </span>
  );
}

const actionClass =
  'w-full px-2 py-1.5 text-left text-xs flex items-center gap-2 rounded transition-colors text-white hover:bg-bambu-dark-tertiary disabled:opacity-50';
const iconClass = 'w-[var(--pc-i3,0.75rem)] h-[var(--pc-i3,0.75rem)]';

/** The slot card's actions for a lit, counted or loadable slot. */
export function SlotSpoolActions({
  state,
  spool,
  canLoad = false,
  onNewRoll,
  onSameRoll,
  onAdjust,
  busy,
}: {
  state: SlotSpoolState;
  /**
   * The inventory spool assigned to the slot, of any kind: offers "correct the
   * amount". A Bambu RFID roll needs it as much as a slot spool: the AMS can
   * read a full roll as empty (a refill on an old tagged spool).
   */
  spool?: InventorySpool | null;
  /** A roll is in the slot and may be loaded by hand, lit or not: a swap the backend missed is never stuck. */
  canLoad?: boolean;
  onNewRoll: () => void;
  onSameRoll: () => void;
  onAdjust: (spool: InventorySpool) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  if (!state && !spool && !canLoad) return null;
  return (
    <>
      {state === 'check' && (
        <p className="px-2 pt-1 text-[11px] leading-snug text-amber-300">{t('slotSpool.checkTitle')}</p>
      )}
      {state === 'new' && (
        <p className="px-2 pt-1 text-[11px] leading-snug text-sky-300">{t('slotSpool.newTitle')}</p>
      )}
      {state === 'check' && (
        <button
          type="button"
          className={actionClass}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onSameRoll();
          }}
        >
          <Undo2 className={iconClass} />
          {t('slotSpool.actionSame')}
        </button>
      )}
      {(state || canLoad) && (
        <button
          type="button"
          className={actionClass}
          onClick={(e) => {
            e.stopPropagation();
            onNewRoll();
          }}
        >
          {state === 'check' ? <CircleHelp className={iconClass} /> : <PackagePlus className={iconClass} />}
          {t('slotSpool.actionNew')}
        </button>
      )}
      {spool && (
        <button
          type="button"
          className={actionClass}
          onClick={(e) => {
            e.stopPropagation();
            onAdjust(spool);
          }}
        >
          <Scale className={iconClass} />
          {t('slotSpool.actionAdjust')}
        </button>
      )}
    </>
  );
}

/** Correct how much is left on the slot's spool; the backend then locks the weight against AMS remain%. */
export function SlotSpoolAdjustModal({ spool, onClose }: { spool: InventorySpool; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const label = spool.label_weight || 1000;
  const [grams, setGrams] = useState<string>(String(Math.max(0, Math.round(label - (spool.weight_used ?? 0)))));
  const parsed = grams.trim() === '' ? NaN : Number(grams);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 5000;

  const mutation = useMutation({
    mutationFn: () => {
      const newLabel = Math.max(label, Math.round(parsed));
      return api.updateSpool(spool.id, { label_weight: newLabel, weight_used: Math.max(0, newLabel - parsed) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spool-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['printer-inventory-remain'] });
      showToast(t('slotSpool.toastAdjusted', { grams: Math.round(parsed) }), 'success');
      onClose();
    },
    onError: (error: Error) => showToast(t('slotSpool.saveFailed', { error: error.message }), 'error'),
  });

  return (
    <ConfirmModal
      title={t('slotSpool.adjustTitle')}
      message={t('slotSpool.adjustMessage')}
      confirmText={t('common.save')}
      cancelText={t('common.cancel')}
      variant="default"
      isLoading={mutation.isPending}
      confirmDisabled={!valid}
      onConfirm={() => {
        if (valid) mutation.mutate();
      }}
      onCancel={onClose}
    >
      <label className="flex items-center gap-2 text-sm text-white">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={5000}
          autoFocus
          aria-label={t('slotSpool.gramsLabel')}
          value={grams}
          onChange={(e) => setGrams(e.target.value)}
          className="w-28 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:border-bambu-green focus:outline-none"
        />
        <span className="text-bambu-gray">{t('slotSpool.gramsSuffix')}</span>
      </label>
    </ConfirmModal>
  );
}
