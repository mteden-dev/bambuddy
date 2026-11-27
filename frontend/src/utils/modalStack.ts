/**
 * Fork: the dialogs open right now, newest on top, so one Escape closes one
 * dialog. Each of our dialogs used to listen for Escape on its own; with two
 * open (an OrcaSlicer upload over the product editor) one key closed both.
 *
 * A layer with `onEscape` is ours: only the top one is asked, and the key
 * goes no further. A layer without it is an upstream modal (ConfirmModal,
 * PrintModal) that handles Escape itself: while it is on top the key is left
 * to it, so the dialog under it stays.
 *
 * The listener is on `window` and added when this module loads, before any
 * modal mounts, so it runs ahead of the upstream modals' own window
 * listeners and can keep the key from the ones underneath.
 */

export interface ModalLayer {
  /** Escape while this layer is on top. Return false to let the key through. */
  onEscape?: () => boolean | void;
  /** Tab stays inside this element while the layer is on top. */
  element?: () => HTMLElement | null;
}

const stack: ModalLayer[] = [];

export function pushModalLayer(layer: ModalLayer): () => void {
  stack.push(layer);
  return () => {
    const index = stack.lastIndexOf(layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function isTopModalLayer(layer: ModalLayer): boolean {
  return stack[stack.length - 1] === layer;
}

/** For tests: the number of open layers. */
export function modalLayerCount(): number {
  return stack.length;
}

// Escape in these closes the browser's own picker first (Safari sends it on).
const PICKER_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

function isPickerInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && PICKER_TYPES.has(target.type);
}

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // Older Safari and jsdom have no checkVisibility: take the element as shown.
    (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true) && !el.closest('[inert]'),
  );
}

function keepTabInside(root: HTMLElement, event: KeyboardEvent) {
  const items = focusableIn(root);
  const active = document.activeElement as HTMLElement | null;
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!active || !root.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && (active === first || !items.includes(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onKeyDown(event: KeyboardEvent) {
  const top = stack[stack.length - 1];
  // Nothing of ours on top: an upstream modal (or nothing) has the key.
  if (!top?.onEscape) return;
  if (event.key === 'Tab') {
    const root = top.element?.();
    if (root) keepTabInside(root, event);
    return;
  }
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  if (isPickerInput(event.target)) return;
  // An open menu closes first; it listens itself.
  if (document.querySelector('[data-context-menu]')) return;
  if (top.onEscape() === false) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

// A hot reload evaluates the module again: one listener, not two.
const LISTENER_KEY = '__forkModalStackKeydown';
type ListenerHost = typeof globalThis & { [LISTENER_KEY]?: (event: KeyboardEvent) => void };
if (typeof window !== 'undefined') {
  const host = globalThis as ListenerHost;
  if (host[LISTENER_KEY]) window.removeEventListener('keydown', host[LISTENER_KEY]);
  host[LISTENER_KEY] = onKeyDown;
  window.addEventListener('keydown', onKeyDown);
}

/*
 * Back closes a sheet (opt-in, phones). Each claim pushes a history entry of
 * the same URL; Back pops the newest and its owner is told. A sheet closed
 * any other way takes its entry back off, unless something has navigated
 * since. One manager for every sheet, so a closing sheet's history.go() never
 * races the push of the next one: pushes wait until the pop has landed.
 */

interface BackClaim {
  marker: string;
  onBack: () => void;
  pushed: boolean;
  done: boolean;
}

const claims: BackClaim[] = [];
const waiting: BackClaim[] = [];
let popsToIgnore = 0;
let markerSeq = 0;

function currentMarker(): string | undefined {
  const state = window.history.state as { modalLayer?: string } | null;
  return state?.modalLayer;
}

function push(claim: BackClaim) {
  window.history.pushState({ ...(window.history.state ?? {}), modalLayer: claim.marker }, '');
  claim.pushed = true;
  claims.push(claim);
}

function flushWaiting() {
  while (popsToIgnore === 0 && waiting.length) {
    const claim = waiting.shift()!;
    if (!claim.done) push(claim);
  }
}

function onPopState() {
  if (popsToIgnore > 0) {
    popsToIgnore -= 1;
    flushWaiting();
    return;
  }
  const top = claims[claims.length - 1];
  if (!top) return;
  const marker = currentMarker();
  // Still on the newest sheet's entry, or forward onto an entry of a sheet
  // closed earlier: no sheet of ours was left.
  if (marker === top.marker) return;
  if (marker && !claims.some((c) => c.marker === marker)) return;
  claims.pop();
  top.done = true;
  // Entries of sheets that closed while this one was over them go too.
  let stale = 0;
  while (claims.length && claims[claims.length - 1].done) {
    claims.pop();
    stale += 1;
  }
  if (stale > 0) {
    popsToIgnore += 1;
    window.history.go(-stale);
  }
  top.onBack();
}

if (typeof window !== 'undefined') {
  const host = globalThis as typeof globalThis & { __forkModalStackPop?: () => void };
  if (host.__forkModalStackPop) window.removeEventListener('popstate', host.__forkModalStackPop);
  host.__forkModalStackPop = onPopState;
  window.addEventListener('popstate', onPopState);
}

/**
 * Put a history entry under a sheet: `onBack` runs when Back takes it off.
 * The entry is pushed a tick later, so a mount undone at once (React's strict
 * mode) pushes nothing. The returned function takes the entry back off when
 * the sheet closes some other way.
 */
export function claimBack(onBack: () => void): () => void {
  const claim: BackClaim = { marker: `modal-${Date.now()}-${++markerSeq}`, onBack, pushed: false, done: false };
  const timer = window.setTimeout(() => {
    if (claim.done) return;
    if (popsToIgnore > 0) waiting.push(claim);
    else push(claim);
  }, 0);
  return () => {
    window.clearTimeout(timer);
    if (claim.done) return;
    claim.done = true;
    if (!claim.pushed) return;
    // Our entries on top that are closed now come off together.
    const topMarker = claims[claims.length - 1]?.marker;
    let count = 0;
    while (claims.length && claims[claims.length - 1].done) {
      claims.pop();
      count += 1;
    }
    // Something navigated since (a dialog that closes by going elsewhere):
    // going back would undo that, so the entries simply stay behind.
    if (count > 0 && currentMarker() === topMarker) {
      popsToIgnore += 1;
      window.history.go(-count);
    }
  };
}

/** For tests: forget every claim. */
export function resetBackClaims() {
  claims.length = 0;
  waiting.length = 0;
  popsToIgnore = 0;
}
