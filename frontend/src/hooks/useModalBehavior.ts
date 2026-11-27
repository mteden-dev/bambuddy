import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { claimBack, isTopModalLayer, pushModalLayer, type ModalLayer } from '../utils/modalStack';

export interface ModalBehaviorOptions {
  /** A request is under way: Escape, Back and `requestClose` do nothing. */
  busy?: boolean;
  /**
   * Back closes it instead of leaving the page: always, or 'narrow' only
   * below 640 px, where the fork's dialogs are bottom sheets.
   */
  backCloses?: boolean | 'narrow';
  /** What Back asks for, when not `onClose`. */
  onBack?: () => void;
  /**
   * False for a popover that places focus and handles Tab itself: only
   * Escape and Back go through the stack.
   */
  manageFocus?: boolean;
}

const NARROW_BELOW = 640;

function useNarrow(watch: boolean): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW_BELOW);
  useEffect(() => {
    if (!watch) return;
    const onResize = () => setNarrow(window.innerWidth < NARROW_BELOW);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [watch]);
  return narrow;
}

const NOT_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);

// Focusing these on a touch screen pops the keyboard over the dialog.
function isTextEntry(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true;
  return el instanceof HTMLInputElement && !NOT_TEXT.has(el.type);
}

function focusStart(root: HTMLElement) {
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const marked = root.querySelector<HTMLElement>('[data-autofocus]');
  const dialog = root.matches('[role="dialog"]') ? root : (root.querySelector<HTMLElement>('[role="dialog"]') ?? root);
  const target = marked && !(coarse && isTextEntry(marked)) ? marked : dialog;
  if (target === dialog && !dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * Fork: what every dialog of ours does.
 *
 * - Escape closes it, only when it is the top dialog (see utils/modalStack),
 *   and not while it is busy. Escape meant for a date or time picker inside
 *   it is left to the picker.
 * - Focus starts on the element marked `data-autofocus` inside `dialog` (on
 *   a touch screen not when that is a text field: the keyboard would cover
 *   the dialog), the `role="dialog"` element otherwise; Tab stays inside;
 *   focus goes back to whatever had it before the dialog opened.
 * - With `backCloses`, Back (a phone's swipe) closes it too.
 *
 * `dialog` is the dialog element or the overlay around it. `onClose` is what
 * Escape and Back ask for: a dialog with unsaved edits passes the function
 * that asks first. The returned function is the same request, ignored while
 * busy, for the backdrop.
 */
export function useModalBehavior(
  onClose: () => void,
  dialog: RefObject<HTMLElement | null>,
  busyOrOptions: boolean | ModalBehaviorOptions = false,
): () => void {
  const options = typeof busyOrOptions === 'boolean' ? { busy: busyOrOptions } : busyOrOptions;
  const close = useRef(onClose);
  close.current = onClose;
  const isBusy = useRef(!!options.busy);
  isBusy.current = !!options.busy;
  const back = useRef(options.onBack);
  back.current = options.onBack;
  const manageFocus = options.manageFocus ?? true;

  const layerRef = useRef<ModalLayer | null>(null);
  if (!layerRef.current) {
    layerRef.current = {
      onEscape: () => {
        if (!isBusy.current) close.current();
      },
      element: manageFocus ? () => dialog.current : undefined,
    };
  }

  useEffect(() => {
    const remove = pushModalLayer(layerRef.current!);
    if (!manageFocus) return remove;
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    if (root && !(previous && root.contains(previous))) focusStart(root);
    return () => {
      remove();
      // Back to the opener, unless focus has moved on to something else
      // that is still there (a dialog opened in this one's place).
      const active = document.activeElement as HTMLElement | null;
      const lost = !active || active === document.body || !active.isConnected || !!root?.contains(active);
      if (lost && previous?.isConnected) previous.focus?.({ preventScroll: true });
    };
    // Once per opening: the refs carry the latest callback and state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const narrow = useNarrow(options.backCloses === 'narrow');
  const backOn = options.backCloses === true || (options.backCloses === 'narrow' && narrow);
  const [backRound, setBackRound] = useState(0);
  useEffect(() => {
    if (!backOn) return;
    return claimBack(() => {
      if (!isBusy.current && isTopModalLayer(layerRef.current!)) (back.current ?? close.current)();
      // Still open (busy, asking first, or under another dialog): a new
      // entry for the next Back. Closed: this update goes nowhere.
      setBackRound((n) => n + 1);
    });
  }, [backOn, backRound]);

  return () => {
    if (!isBusy.current) close.current();
  };
}

/**
 * For upstream modals (ConfirmModal, PrintModal): one line marks them as open,
 * so the fork dialog under one leaves Escape to it. They keep their own
 * Escape handling.
 */
export function useUpstreamModalLayer() {
  useEffect(() => pushModalLayer({}), []);
}
