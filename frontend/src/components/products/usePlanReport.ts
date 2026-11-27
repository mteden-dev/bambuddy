import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanSideEffects } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

/**
 * Fork (products): what a plan did beyond the product asked for. Gives the
 * sentence to add to the action's toast ("Also replanned: X, Y.", empty when
 * none) and shows the products whose plan failed in a warning that stays
 * until dismissed: their orders are not in the queue.
 */
export function usePlanReport() {
  const { t } = useTranslation();
  const { showPersistentToast } = useToast();
  return useCallback(
    (result: PlanSideEffects | null | undefined): string => {
      const failed = result?.plan_failed ?? [];
      if (failed.length) {
        showPersistentToast(
          `plan-failed-${Date.now()}`,
          t('products.planFailed', { names: failed.map((p) => p.name).join(', ') }),
          'warning',
        );
      }
      const also = result?.also_replanned ?? [];
      return also.length ? t('products.alsoReplanned', { names: also.map((p) => p.name).join(', ') }) : '';
    },
    [t, showPersistentToast],
  );
}

/** "Message." plus the plan's note, if any. */
export function withNote(message: string, note: string): string {
  return note ? `${message} ${note}` : message;
}
