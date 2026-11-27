import { useRef, type ComponentProps } from 'react';
import { ConfirmModal } from './ConfirmModal';
import { useModalBehavior } from '../hooks/useModalBehavior';

/**
 * Fork: the upstream ConfirmModal with the fork's dialog behaviour around it
 * (focus moved in and back, Tab kept inside, Escape through the modal stack
 * so only this one closes). Wrapped rather than changed, to keep the upstream
 * file as it is. Escape and the backdrop do nothing while it is loading or
 * not dismissible, as in ConfirmModal itself.
 */
export function FocusedConfirmModal(props: ComponentProps<typeof ConfirmModal>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { isLoading = false, dismissible = true, onCancel, title } = props;
  useModalBehavior(onCancel, wrapRef, isLoading || !dismissible);
  // Absolute: out of the flow of whatever row it is rendered in (no gap
  // shifts behind the overlay), and with no z-index it makes no stacking
  // context, so the overlay's own z-index still counts.
  return (
    <div ref={wrapRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="absolute outline-none">
      <ConfirmModal {...props} />
    </div>
  );
}
