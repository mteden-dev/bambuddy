/**
 * Fork: the modal stack. One Escape closes one dialog (the top one), a busy
 * dialog keeps it, an edited one asks, focus moves in, stays in and goes back,
 * and Back closes a sheet that asks for it.
 */

import { useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useModalBehavior, useUpstreamModalLayer, type ModalBehaviorOptions } from '../../hooks/useModalBehavior';
import { modalLayerCount, resetBackClaims } from '../../utils/modalStack';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useDiscardGuard } from '../../components/products/useDiscardGuard';

function Dialog({
  name,
  onClose,
  options,
  children,
}: {
  name: string;
  onClose: () => void;
  options?: boolean | ModalBehaviorOptions;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalBehavior(onClose, ref, options);
  return (
    <div ref={ref} role="dialog" aria-label={name}>
      <button type="button">{name} first</button>
      {children}
      <button type="button">{name} last</button>
    </div>
  );
}

/** Two dialogs, the second over the first, each closed by its own flag. */
function Two({ topOptions }: { topOptions?: boolean | ModalBehaviorOptions }) {
  const [lower, setLower] = useState(true);
  const [upper, setUpper] = useState(true);
  return (
    <>
      {lower && <Dialog name="lower" onClose={() => setLower(false)} />}
      {upper && <Dialog name="upper" onClose={() => setUpper(false)} options={topOptions} />}
    </>
  );
}

const escape = () => fireEvent.keyDown(window, { key: 'Escape' });

describe('useModalBehavior', () => {
  it('closes only the top dialog on Escape, then the one under it', () => {
    render(<Two />);
    escape();
    expect(screen.queryByRole('dialog', { name: 'upper' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'lower' })).toBeInTheDocument();
    escape();
    expect(screen.queryByRole('dialog', { name: 'lower' })).not.toBeInTheDocument();
    expect(modalLayerCount()).toBe(0);
  });

  it('keeps a busy dialog open, and the one under it too', () => {
    render(<Two topOptions={{ busy: true }} />);
    escape();
    expect(screen.getByRole('dialog', { name: 'upper' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'lower' })).toBeInTheDocument();
  });

  it('leaves Escape to an upstream modal on top and keeps the fork dialog under it', () => {
    function WithConfirm() {
      const [open, setOpen] = useState(true);
      const [asking, setAsking] = useState(true);
      return (
        <>
          {open && <Dialog name="editor" onClose={() => setOpen(false)} />}
          {asking && <ConfirmModal title="Sure?" message="Really" onConfirm={() => {}} onCancel={() => setAsking(false)} />}
        </>
      );
    }
    render(<WithConfirm />);
    escape();
    expect(screen.queryByText('Sure?')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'editor' })).toBeInTheDocument();
  });

  it('keeps Escape from an upstream modal under a fork dialog', () => {
    function Under() {
      useUpstreamModalLayer();
      return null;
    }
    let upstreamClosed = false;
    const upstreamListener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') upstreamClosed = true;
    };
    window.addEventListener('keydown', upstreamListener);
    try {
      function Stack() {
        const [open, setOpen] = useState(true);
        return (
          <>
            <Under />
            {open && <Dialog name="upload" onClose={() => setOpen(false)} />}
          </>
        );
      }
      render(<Stack />);
      escape();
      expect(screen.queryByRole('dialog', { name: 'upload' })).not.toBeInTheDocument();
      expect(upstreamClosed).toBe(false);
    } finally {
      window.removeEventListener('keydown', upstreamListener);
    }
  });

  it('asks before an edited dialog closes on Escape', () => {
    function Edited() {
      const [open, setOpen] = useState(true);
      const { requestClose, confirm } = useDiscardGuard(true, () => setOpen(false));
      return open ? (
        <Dialog name="edited" onClose={requestClose}>
          {confirm}
        </Dialog>
      ) : null;
    }
    render(<Edited />);
    escape();
    // Asked, still open; Escape on the question only takes the question away.
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    escape();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'edited' })).toBeInTheDocument();
    // Asked again and answered: closed.
    escape();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog', { name: 'edited' })).not.toBeInTheDocument();
  });

  it('ignores Escape meant for a date or time picker', () => {
    const closed: string[] = [];
    render(
      <Dialog name="dated" onClose={() => closed.push('dated')}>
        <input type="datetime-local" aria-label="due" />
        <input type="text" aria-label="note" />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText('due'), { key: 'Escape' });
    expect(closed).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText('note'), { key: 'Escape' });
    expect(closed).toEqual(['dated']);
  });

  it('moves focus in, keeps Tab inside and gives focus back on close', () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          {open && <Dialog name="focus" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'focus' });
    expect(dialog).toHaveFocus();
    const last = screen.getByRole('button', { name: 'focus last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'focus first' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    escape();
    expect(opener).toHaveFocus();
  });

  it('starts on the marked control, but not a text field on a touch screen', () => {
    const original = window.matchMedia;
    const marked = (
      <Dialog name="marked" onClose={() => {}}>
        <input data-autofocus aria-label="name" />
      </Dialog>
    );
    const view = render(marked);
    expect(screen.getByLabelText('name')).toHaveFocus();
    view.unmount();
    window.matchMedia = ((query: string) => ({ ...original(query), matches: query === '(pointer: coarse)' })) as typeof window.matchMedia;
    try {
      render(marked);
      expect(screen.getByRole('dialog', { name: 'marked' })).toHaveFocus();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('Back closes a sheet', () => {
  beforeEach(() => resetBackClaims());
  afterEach(() => resetBackClaims());

  // jsdom traverses history asynchronously; wait for the popstate to land.
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

  it('pushes an entry, closes on Back, and takes the entry off when closed otherwise', async () => {
    const start = window.history.length;
    function Sheet() {
      const [open, setOpen] = useState(true);
      return open ? <Dialog name="sheet" onClose={() => setOpen(false)} options={{ backCloses: true }} /> : null;
    }
    const first = render(<Sheet />);
    await settle();
    expect(window.history.length).toBe(start + 1);
    await act(async () => window.history.back());
    await settle();
    expect(screen.queryByRole('dialog', { name: 'sheet' })).not.toBeInTheDocument();
    first.unmount();

    // Closed by Escape: its entry goes, and the next Back is not swallowed.
    render(<Sheet />);
    await settle();
    const state = window.history.state as { modalLayer?: string } | null;
    expect(state?.modalLayer).toBeTruthy();
    escape();
    await settle();
    expect((window.history.state as { modalLayer?: string } | null)?.modalLayer).toBeUndefined();
  });

  it('keeps a busy sheet open on Back and puts a new entry under it', async () => {
    render(<Dialog name="busy" onClose={() => {}} options={{ busy: true, backCloses: true }} />);
    await settle();
    await act(async () => window.history.back());
    await settle();
    expect(screen.getByRole('dialog', { name: 'busy' })).toBeInTheDocument();
    expect((window.history.state as { modalLayer?: string } | null)?.modalLayer).toBeTruthy();
  });

  it('pushes nothing for a mount undone at once (strict mode)', async () => {
    const view = render(<Dialog name="flash" onClose={() => {}} options={{ backCloses: true }} />);
    view.unmount();
    await settle();
    expect((window.history.state as { modalLayer?: string } | null)?.modalLayer).toBeUndefined();
  });
});
