import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FocusedConfirmModal } from '../FocusedConfirmModal';

/**
 * Fork (products): Escape on a dialog holding unsaved edits asks before
 * throwing them away. `requestClose` closes at once when nothing was changed;
 * `confirm` is the question, for the dialog to render (never inside an
 * overlay that closes on a click: the confirm's own clicks would ask again).
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const requestClose = () => (dirty ? setAsking(true) : onClose());
  const confirm = asking ? (
    <FocusedConfirmModal
      title={t('products.discard.title')}
      message={t('products.discard.message')}
      confirmText={t('products.discard.confirm')}
      cancelText={t('products.discard.keep')}
      variant="warning"
      onConfirm={() => {
        setAsking(false);
        onClose();
      }}
      onCancel={() => setAsking(false)}
    />
  ) : null;
  return { requestClose, confirm };
}
