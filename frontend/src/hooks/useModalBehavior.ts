import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Fork (products): what every dialog of ours does. Escape closes it (unless
 * it is busy), focus starts on the element marked ``data-autofocus`` inside
 * ``dialog`` (the dialog itself without one) and goes back to whatever had it
 * before the dialog opened.
 */
export function useModalBehavior(onClose: () => void, dialog: RefObject<HTMLElement | null>, busy = false) {
  const close = useRef(onClose);
  close.current = onClose;
  const isBusy = useRef(busy);
  isBusy.current = busy;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const start = dialog.current?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.current;
    start?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy.current) close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
    // Once per opening: the refs carry the latest callback and state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
