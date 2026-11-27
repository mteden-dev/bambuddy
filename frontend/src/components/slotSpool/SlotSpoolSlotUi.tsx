import { useContext, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CircleHelp, PackagePlus, Scale, Undo2 } from 'lucide-react';
import { api, type InventorySpool } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { FocusedConfirmModal } from '../FocusedConfirmModal';
import { MAX_ROLL_GRAMS, parseGrams, type SlotSpoolState } from '../../utils/slotSpools';
import { SlotCardDismissContext } from './slotCardDismiss';

/**
 * Fork (slot spools): the printer card's side of a roll counted per AMS slot.
 * The rules for which slot lights up are in utils/slotSpools, the data hooks in
 * hooks/useSlotSpools.
 */

/**
 * "NEW" / "same roll?" chip in the corner of a lit slot. Each state has its own
 * icon, so "same roll?" never reads as the amber "expected slot" of a paused
 * print; larger on a touch screen, where 8 px cannot be read.
 */
export function SlotSpoolBadge({ state }: { state: SlotSpoolState }) {
  const { t } = useTranslation();
  if (!state) return null;
  const isNew = state === 'new';
  const Icon = isNew ? PackagePlus : CircleHelp;
  return (
    <span
      data-testid={`slot-spool-badge-${state}`}
      title={t(isNew ? 'slotSpool.newTitle' : 'slotSpool.checkTitle')}
      className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-px px-1 py-px text-[length:var(--pc-t8,8px)] any-pointer-coarse:text-[10px] font-bold rounded pointer-events-none leading-none z-10 whitespace-nowrap ${
        isNew ? 'bg-sky-400 text-bambu-dark' : 'bg-fuchsia-400 text-bambu-dark'
      }`}
    >
      <Icon aria-hidden className="w-[1.1em] h-[1.1em] shrink-0" />
      {t(isNew ? 'slotSpool.badgeNew' : 'slotSpool.badgeCheck')}
    </span>
  );
}

/** Why a slot's card offers no slot spool, rather than offering nothing. */
export type SlotSpoolNoteReason = 'spoolman' | 'external' | 'rfid';

export function SlotSpoolNote({ reason }: { reason: SlotSpoolNoteReason }) {
  const { t } = useTranslation();
  const key = reason === 'spoolman'
    ? 'slotSpool.notApplicableSpoolman'
    : reason === 'external'
      ? 'slotSpool.notApplicableExternal'
      : 'slotSpool.notApplicableRfid';
  return (
    <p data-testid={`slot-spool-note-${reason}`} className="px-2 pt-1 text-[11px] leading-snug text-bambu-gray">
      {t(key)}
    </p>
  );
}

// 44 px rows on a touch screen: "Same roll" and "New roll…" sit on top of each
// other and a mis-tap restarts the count.
const actionClass =
  'w-full px-2 py-1.5 any-pointer-coarse:min-h-[44px] text-left text-xs flex items-center gap-2 rounded transition-colors text-white hover:bg-bambu-dark-tertiary disabled:opacity-50';
const iconClass = 'w-[var(--pc-i3,0.75rem)] h-[var(--pc-i3,0.75rem)]';

/** The slot card's actions for a lit, counted or loadable slot. */
export function SlotSpoolActions({
  state,
  spool,
  canLoad = false,
  note,
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
  /** Why slot spools do not apply here, shown as a muted line. */
  note?: SlotSpoolNoteReason | null;
  onNewRoll: () => void;
  onSameRoll: () => void;
  onAdjust: (spool: InventorySpool) => void;
  /** An answer is on its way: every action waits for it. */
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const dismissCard = useContext(SlotCardDismissContext);
  if (!state && !spool && !canLoad && !note) return null;
  // The dialogs these open sit under the card (see slotCardDismiss).
  const openDialog = (open: () => void) => {
    dismissCard?.();
    open();
  };
  return (
    <>
      {note && <SlotSpoolNote reason={note} />}
      {state === 'check' && (
        <p className="px-2 pt-1 text-[11px] leading-snug text-fuchsia-300">{t('slotSpool.checkTitle')}</p>
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
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            openDialog(onNewRoll);
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
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            openDialog(() => onAdjust(spool));
          }}
        >
          <Scale className={iconClass} />
          {t('slotSpool.actionAdjust')}
        </button>
      )}
    </>
  );
}

/**
 * Correct how much is left on the slot's spool; the backend then locks the
 * weight against AMS remain%.
 *
 * A slot feeding the running print is warned about rather than fixed: the
 * usage tracker charges the whole print at its end, the part used before the
 * correction included, so a correction made now counts that part twice.
 */
export function SlotSpoolAdjustModal({
  spool,
  feedsPrint = false,
  onClose,
}: {
  spool: InventorySpool;
  /** The slot feeds the print running now. */
  feedsPrint?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const label = spool.label_weight || 1000;
  const [grams, setGrams] = useState<string>(String(Math.max(0, Math.round(label - (spool.weight_used ?? 0)))));
  const parsed = parseGrams(grams);
  const valid = parsed != null && parsed >= 0 && parsed <= MAX_ROLL_GRAMS;

  const mutation = useMutation({
    mutationFn: (left: number) => {
      const newLabel = Math.max(label, Math.round(left));
      return api.updateSpool(spool.id, { label_weight: newLabel, weight_used: Math.max(0, newLabel - left) });
    },
    onSuccess: (_data, left) => {
      queryClient.invalidateQueries({ queryKey: ['spool-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['printer-inventory-remain'] });
      showToast(t('slotSpool.toastAdjusted', { grams: Math.round(left) }), 'success');
      onClose();
    },
    onError: (error: Error) => showToast(t('slotSpool.saveFailed', { error: error.message }), 'error'),
  });

  return (
    <FocusedConfirmModal
      title={t('slotSpool.adjustTitle')}
      message={t('slotSpool.adjustMessage')}
      confirmText={t('common.save')}
      cancelText={t('common.cancel')}
      variant={feedsPrint ? 'warning' : 'default'}
      isLoading={mutation.isPending}
      confirmDisabled={!valid}
      dismissible={!mutation.isPending}
      onConfirm={() => {
        if (valid && parsed != null) mutation.mutate(parsed);
      }}
      onCancel={() => {
        if (!mutation.isPending) onClose();
      }}
    >
      {feedsPrint && (
        <p
          data-testid="slot-spool-adjust-feeds-print"
          className="flex gap-2 mb-3 p-2 rounded border border-amber-500/40 bg-amber-500/10 text-xs text-amber-300"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {t('slotSpool.adjustFeedsPrint')}
        </p>
      )}
      <label className="flex items-center gap-2 text-sm text-white">
        <input
          type="text"
          inputMode="decimal"
          data-autofocus
          aria-label={t('slotSpool.gramsLabel')}
          aria-invalid={!valid}
          value={grams}
          onChange={(e) => setGrams(e.target.value)}
          className="w-28 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:border-bambu-green focus:outline-none"
        />
        <span className="text-bambu-gray">{t('slotSpool.gramsSuffix')}</span>
      </label>
      {!valid && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {t('slotSpool.gramsInvalidAdjust', { max: MAX_ROLL_GRAMS })}
        </p>
      )}
    </FocusedConfirmModal>
  );
}

/** One slot that asks for something, for the line under the AMS row. */
export interface SlotSpoolAsk {
  key: string;
  /** Short slot name, e.g. "A2". */
  label: string;
  state: Exclude<SlotSpoolState, null>;
  onNewRoll: () => void;
  /** Settles when the answer is in; the dialog stays up until then. */
  onSameRoll: () => Promise<unknown>;
}

/**
 * One line under the AMS row naming what the slots ask ("A2: new roll · A4:
 * same roll?"). The ring and the chip on a slot can be hidden behind the
 * expected / active ring or be too small on a phone; this line is not, and a
 * tap on an item opens what answers it.
 */
export function SlotSpoolAsks({ asks, busy }: { asks: SlotSpoolAsk[]; busy?: boolean }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<SlotSpoolAsk | null>(null);
  if (asks.length === 0) return null;
  return (
    <div data-testid="slot-spool-asks" className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
      {asks.map((ask, index) => {
        const isNew = ask.state === 'new';
        const Icon = isNew ? PackagePlus : CircleHelp;
        return (
          <span key={ask.key} className="inline-flex items-center">
            {index > 0 && <span className="text-bambu-gray px-1" aria-hidden>·</span>}
            <button
              type="button"
              disabled={busy}
              onClick={() => (isNew ? ask.onNewRoll() : setAsking(ask))}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 any-pointer-coarse:min-h-[44px] rounded hover:bg-bambu-dark-tertiary disabled:opacity-50 ${
                isNew ? 'text-sky-300' : 'text-fuchsia-300'
              }`}
            >
              <Icon aria-hidden className="w-3.5 h-3.5 shrink-0" />
              {t(isNew ? 'slotSpool.askNew' : 'slotSpool.askCheck', { slot: ask.label })}
            </button>
          </span>
        );
      })}
      {asking && (
        <FocusedConfirmModal
          title={t('slotSpool.promptTitle', { slot: asking.label })}
          message={t('slotSpool.checkTitle')}
          confirmText={t('slotSpool.actionSame')}
          cancelText={t('common.cancel')}
          isLoading={busy}
          dismissible={!busy}
          onConfirm={async () => {
            try {
              await asking.onSameRoll();
            } catch {
              // The mutation's own toast says what failed.
            }
            setAsking(null);
          }}
          onCancel={() => {
            if (!busy) setAsking(null);
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const ask = asking;
              setAsking(null);
              ask.onNewRoll();
            }}
            className="w-full mb-3 px-3 py-2 any-pointer-coarse:min-h-[44px] flex items-center gap-2 rounded-lg border border-bambu-dark-tertiary text-sm text-white hover:border-bambu-gray disabled:opacity-50"
          >
            <PackagePlus className="w-4 h-4" />
            {t('slotSpool.actionNew')}
          </button>
        </FocusedConfirmModal>
      )}
    </div>
  );
}
