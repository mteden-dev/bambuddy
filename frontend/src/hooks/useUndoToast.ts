import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';

// How long the "Undo" stays on screen.
const UNDO_MS = 6000;

/**
 * Fork (products): a success toast with an "Undo" button for a few seconds.
 * Built on the persistent toast, which is the one that carries an action.
 */
export function useUndoToast() {
  const { t } = useTranslation();
  const { showPersistentToast, dismissToast } = useToast();
  return useCallback(
    (message: string, onUndo: () => void) => {
      const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      showPersistentToast(id, message, 'success', { action: { label: t('products.undo'), onClick: onUndo } });
      window.setTimeout(() => dismissToast(id), UNDO_MS);
    },
    [showPersistentToast, dismissToast, t],
  );
}
