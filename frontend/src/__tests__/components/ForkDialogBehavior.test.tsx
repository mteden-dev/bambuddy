/**
 * Fork: the dialogs' keyboard and focus behaviour through the modal stack.
 * Escape closes only the top dialog (asking first when there are edits),
 * focus moves into a dialog, Tab stays inside it, and focus goes back to the
 * control that opened it.
 */
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProductEditorModal } from '../../components/products/ProductEditorModal';
import { StaffedHoursDialog } from '../../components/StaffedHoursDialog';
import { SlicerImportDialog } from '../../components/SlicerImportDialog';
import { QueueJobDetails } from '../../components/QueueJobDetails';
import { focusableIn, resetBackClaims } from '../../utils/modalStack';
import type { PrintQueueItem, Printer } from '../../api/client';

vi.mock('../../components/PrintModal', () => ({ PrintModal: () => null }));

const escape = () => fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
const t = (key: string) => key;

/** A button that opens `children(close)`, so focus has somewhere to go back to. */
function Opener({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && children(() => setOpen(false))}
    </>
  );
}

function openFromButton() {
  const opener = screen.getByRole('button', { name: 'open' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

/** Tab from the last control lands on the first, Shift+Tab from the first on the last. */
function expectTabStaysIn(dialog: HTMLElement) {
  const items = focusableIn(dialog);
  expect(items.length).toBeGreaterThan(1);
  const first = items[0];
  const last = items[items.length - 1];
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(last).toHaveFocus();
}

describe('ProductEditorModal', () => {
  it('starts on the name, keeps Tab inside, closes on Escape and gives focus back', async () => {
    render(<Opener>{(close) => <ProductEditorModal product={null} onClose={close} />}</Opener>);
    const opener = openFromButton();
    const dialog = screen.getByRole('dialog', { name: 'New product' });
    expect(within(dialog).getAllByRole('textbox')[0]).toHaveFocus();
    expectTabStaysIn(dialog);
    escape();
    expect(screen.queryByRole('dialog', { name: 'New product' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('asks before Escape drops an edit', () => {
    const onClose = vi.fn();
    render(<ProductEditorModal product={null} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'New product' });
    fireEvent.change(document.activeElement!, { target: { value: 'Box' } });
    escape();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    // Escape on the question keeps the edit.
    escape();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    escape();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('StaffedHoursDialog', () => {
  const week = Array.from({ length: 7 }, () => ({ start: '07:00', end: '22:00' }));
  beforeEach(() => {
    server.use(
      http.get('/api/v1/queue/staffed-hours', () =>
        HttpResponse.json({ enabled: false, timezone: 'UTC', days: week, clear_minutes: 0, learn: true, marks: [] }),
      ),
    );
  });

  it('moves focus in, keeps Tab inside, and Escape closes it unchanged with focus back', async () => {
    render(
      <Opener>{(close) => <StaffedHoursDialog canEdit waitsForPlate initialTab="week" onClose={close} t={t} />}</Opener>,
    );
    const opener = openFromButton();
    const dialog = screen.getByTestId('staffed-hours-dialog');
    expect(dialog).toHaveFocus();
    await within(dialog).findByTestId('staffed-hours-body');
    expectTabStaysIn(dialog);
    escape();
    expect(screen.queryByTestId('staffed-hours-dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('asks on Escape when something changed, like Cancel does', async () => {
    const onClose = vi.fn();
    render(<StaffedHoursDialog canEdit waitsForPlate initialTab="week" onClose={onClose} t={t} />);
    const dialog = screen.getByTestId('staffed-hours-dialog');
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'queue.timeline.staffed.enabled' }));
    escape();
    expect(within(dialog).getByTestId('staffed-discard-ask')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Asked already: Escape goes back to editing.
    escape();
    expect(within(dialog).queryByTestId('staffed-discard-ask')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('on a phone', () => {
    const width = window.innerWidth;
    beforeEach(() => {
      resetBackClaims();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    });
    afterEach(() => {
      resetBackClaims();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    });

    const pause = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    it('closes the unchanged sheet on Back', async () => {
      render(
        <Opener>{(close) => <StaffedHoursDialog canEdit waitsForPlate initialTab="week" onClose={close} t={t} />}</Opener>,
      );
      openFromButton();
      await pause();
      await act(async () => window.history.back());
      await waitFor(() => expect(screen.queryByTestId('staffed-hours-dialog')).not.toBeInTheDocument());
    });

    it('asks on Back when something changed, and a second Back goes back to editing', async () => {
      const onClose = vi.fn();
      render(<StaffedHoursDialog canEdit waitsForPlate initialTab="week" onClose={onClose} t={t} />);
      const dialog = screen.getByTestId('staffed-hours-dialog');
      fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'queue.timeline.staffed.enabled' }));
      await pause();
      await act(async () => window.history.back());
      await waitFor(() => expect(within(dialog).getByTestId('staffed-discard-ask')).toBeInTheDocument());
      expect(onClose).not.toHaveBeenCalled();
      await pause();
      await act(async () => window.history.back());
      await waitFor(() => expect(within(dialog).queryByTestId('staffed-discard-ask')).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

describe('SlicerImportDialog over another dialog', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/slicer-inbox/pending', () =>
        HttpResponse.json([
          {
            id: 10, filename: 'Cube.gcode.3mf', folder_id: 7, plate: null, print: false, sliced_for_model: 'P1S',
            print_time_seconds: 3600, filament_used_grams: 12, created_at: '2026-11-17T08:00:00Z',
          },
        ]),
      ),
      http.get('/api/v1/settings/ui-flags', () => HttpResponse.json({ slicer_inbox_manual_start: false })),
      http.get('/api/v1/library/files/:id/plates', () =>
        HttpResponse.json({ file_id: 10, filename: 'x', is_multi_plate: false, plates: [] }),
      ),
    );
  });

  it('takes the first Escape itself and leaves the editor under it open, with its focus back', async () => {
    const onEditorClose = vi.fn();
    render(
      <>
        <ProductEditorModal product={null} onClose={onEditorClose} />
        <SlicerImportDialog />
      </>,
    );
    const name = within(screen.getByRole('dialog', { name: 'New product' })).getAllByRole('textbox')[0];
    expect(name).toHaveFocus();
    const upload = await screen.findByRole('dialog', { name: /OrcaSlicer|slicerInbox/i });
    expect(upload).toHaveFocus();
    expectTabStaysIn(upload);

    escape();
    await waitFor(() => expect(screen.queryByText('Cube.gcode.3mf')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'New product' })).toBeInTheDocument();
    expect(onEditorClose).not.toHaveBeenCalled();
    expect(name).toHaveFocus();
  });
});

describe('QueueJobDetails', () => {
  const printers = [{ id: 1, name: 'P1S-01', model: 'P1S', is_active: true }] as unknown as Printer[];
  const item = {
    id: 5, printer_id: null, target_model: 'P1S', status: 'pending', position: 1, archive_name: 'Lid',
    print_time_seconds: 3600, scheduled_time: null, manual_start: false, waiting_reason: null, created_by_id: 1,
  } as unknown as PrintQueueItem;
  const details = (close: () => void) => (
    <QueueJobDetails
      item={item}
      printers={printers}
      pinChoices={printers}
      canModify
      onPin={() => {}}
      onEdit={() => {}}
      onClose={close}
      t={t}
    />
  );

  it('moves focus in, keeps Tab inside, closes on Escape and gives focus back', () => {
    render(<Opener>{details}</Opener>);
    const opener = openFromButton();
    const dialog = screen.getByTestId('queue-job-details');
    expect(dialog).toHaveFocus();
    expectTabStaysIn(dialog);
    escape();
    expect(screen.queryByTestId('queue-job-details')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  describe('on a phone', () => {
    const width = window.innerWidth;
    beforeEach(() => {
      resetBackClaims();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    });
    afterEach(() => {
      resetBackClaims();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    });

    it('closes the sheet on Back', async () => {
      render(<Opener>{details}</Opener>);
      openFromButton();
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      await act(async () => window.history.back());
      await waitFor(() => expect(screen.queryByTestId('queue-job-details')).not.toBeInTheDocument());
    });
  });
});
