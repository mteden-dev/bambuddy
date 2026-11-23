/**
 * The timeline draws every pending job where GET /queue/forecast expects the
 * scheduler to run it, "Any <model>" jobs included (fork). Dragging a job that
 * has not started changes the queue order: dropped in a gap, it goes before
 * the job on the right. It never pins. A click opens the job's details, where
 * it is pinned to a printer or handed back to any printer of its model.
 *
 * Dispatch order (Shortest-Job-First, #3043) and the placement itself are the
 * server's: see backend/tests/unit/test_queue_forecast.py.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueueTimelineView } from '../../components/QueueTimelineView';
import { api } from '../../api/client';
import type { PrintQueueItem, Printer, QueueForecast } from '../../api/client';

vi.mock('../../api/client', () => ({
  api: {
    getQueueForecast: vi.fn(),
    // The details' tag chips; no job asks for tags here.
    getQueueItemTags: vi.fn().mockResolvedValue([]),
    getPrinterTags: vi.fn().mockResolvedValue([]),
    getLibraryTags: vi.fn().mockResolvedValue([]),
  },
}));

const HOUR_MS = 3600 * 1000;

const printers = [
  { id: 1, name: 'P1S-01', model: 'P1S', is_active: true },
  { id: 2, name: 'P1S-02', model: 'P1S', is_active: true },
  { id: 3, name: 'H2D-01', model: 'H2D', is_active: true },
  { id: 4, name: 'P1S-03', model: 'P1S', is_active: true },
] as unknown as Printer[];

const job = (id: number, name: string, over: Partial<PrintQueueItem> = {}) =>
  ({
    id,
    printer_id: null,
    target_model: 'P1S',
    status: 'pending',
    position: id,
    archive_name: name,
    print_time_seconds: 3600,
    scheduled_time: null,
    manual_start: false,
    waiting_reason: null,
    created_by_id: 1,
    ...over,
  }) as unknown as PrintQueueItem;

const pinned = job(1, 'Pinned box', { printer_id: 1, target_model: null });
const anyJob = job(2, 'Any tray');
const staged = job(3, 'Staged lid', { manual_start: true });
const laterJob = job(4, 'Later cup');
const queueItems = [pinned, anyJob, staged, laterJob];

function iso(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * HOUR_MS).toISOString();
}

function forecast(over: Partial<QueueForecast> = {}): QueueForecast {
  return {
    generated_at: iso(0),
    placements: [
      { item_id: 1, printer_id: 1, start: iso(0), end: iso(1), projected: false },
      { item_id: 2, printer_id: 2, start: iso(0), end: iso(1), projected: true },
      { item_id: 4, printer_id: 2, start: iso(3), end: iso(4), projected: true },
    ],
    off_timeline: [{ item_id: 3, reason: 'manual_start', detail: null }],
    printers: [
      { printer_id: 1, free_at: iso(0), available: true, connected: true, external_print: false, awaiting_plate_clear: false },
      { printer_id: 2, free_at: iso(0), available: true, connected: true, external_print: false, awaiting_plate_clear: false },
      { printer_id: 3, free_at: iso(2), available: true, connected: true, external_print: true, awaiting_plate_clear: false },
      { printer_id: 4, free_at: iso(0), available: true, connected: true, external_print: false, awaiting_plate_clear: false },
    ],
    refusals: {
      '1': { '3': { code: 'model', detail: 'P1S' } },
      '2': { '3': { code: 'model', detail: 'P1S' } },
      '3': { '3': { code: 'model', detail: 'P1S' } },
      '4': { '3': { code: 'model', detail: 'P1S' } },
    },
    ...over,
  };
}

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key;

function renderTimeline(props: Partial<Parameters<typeof QueueTimelineView>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QueueTimelineView
        queueItems={queueItems}
        printers={printers}
        printerStatuses={{}}
        sjfEnabled={false}
        t={t}
        {...props}
      />
    </QueryClientProvider>,
  );
}

function lane(printerId: number): HTMLElement {
  return document.querySelector(`[data-lane="${printerId}"]`) as HTMLElement;
}

function bar(name: string): HTMLElement {
  return screen.getByTitle((title) => title.startsWith(name));
}

describe('QueueTimelineView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getQueueForecast).mockResolvedValue(forecast());
  });

  it('draws an "Any" job on the printer the forecast gives it, dashed, and a pinned job solid', async () => {
    renderTimeline();

    const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
    expect(anyBar).toHaveAttribute('data-kind', 'projected');
    expect(anyBar.className).toContain('border-dashed');
    expect(anyBar).toHaveTextContent('queue.filter.any P1S');

    const pinnedBar = within(lane(1)).getByTitle((title) => title.startsWith('Pinned box'));
    expect(pinnedBar).toHaveAttribute('data-kind', 'pinned');
    expect(pinnedBar.className).not.toContain('border-dashed');
  });

  it('lists jobs the forecast leaves off the lanes with the reason', async () => {
    renderTimeline();

    const chip = await screen.findByTitle((title) => title.startsWith('Staged lid'));
    expect(chip).toHaveTextContent('queue.timeline.offTimeline.manualStart');
    expect(screen.getByText(/queue\.timeline\.offTimeline\.title/)).toHaveTextContent('"count":1');
  });

  it('shows a print the printer runs outside the queue', async () => {
    renderTimeline();

    expect(await within(lane(3)).findByText('queue.timeline.externalPrint')).toBeInTheDocument();
  });

  describe('dragging', () => {
    // jsdom lays nothing out, so dnd-kit would see every element at 0,0.
    // Each lane is an 800px row 56px tall; a bar is 100px wide at its own
    // left (a share of the 800px), on its lane's row. The drag overlay starts
    // where the dragged bar was, as a browser lays it out.
    let rectSpy: ReturnType<typeof vi.spyOn>;
    let dragFromLane = 1;
    beforeEach(() => {
      rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const el = this as HTMLElement;
        const laneEl = el.closest('[data-lane]') as HTMLElement | null;
        const index = (laneEl ? Number(laneEl.dataset.lane) : dragFromLane) - 1;
        const isLane = el.hasAttribute('data-lane');
        const top = index * 56 + (isLane ? 0 : 8);
        const height = isLane ? 56 : 40;
        const width = isLane ? 800 : 100;
        const left = el.hasAttribute('data-bar-item') ? (parseFloat(el.style.left) / 100) * 800 : 0;
        return { x: left, y: top, top, left, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
      });
    });
    afterEach(() => rectSpy.mockRestore());

    function drag(el: HTMLElement, toLane: number, fromLane: number, toX = 20) {
      dragFromLane = fromLane;
      const fromX = el.getBoundingClientRect().left + 10;
      fireEvent.mouseDown(el, { button: 0, clientX: fromX, clientY: (fromLane - 1) * 56 + 20 });
      act(() => {
        fireEvent.mouseMove(document, { clientX: fromX + 10, clientY: (fromLane - 1) * 56 + 20 });
      });
      act(() => {
        fireEvent.mouseMove(document, { clientX: toX, clientY: (toLane - 1) * 56 + 20 });
      });
    }

    function drop() {
      act(() => {
        fireEvent.mouseUp(document);
      });
    }

    it('drops a job before the one on the right of the gap, and never pins it', async () => {
      const onReorder = vi.fn(() => true);
      const onPinItem = vi.fn();
      renderTimeline({ onReorder, onPinItem });
      const later = await within(lane(2)).findByTitle((title) => title.startsWith('Later cup'));

      drag(later, 2, 2, 0);
      expect(screen.getByTestId('drop-marker-2')).toBeInTheDocument();
      drop();

      expect(onReorder).toHaveBeenCalledWith(4, 2, false);
      expect(onPinItem).not.toHaveBeenCalled();
      expect(screen.queryByTestId('drop-marker-2')).toBeNull();
    });

    it('drops after the last job of a lane', async () => {
      const onReorder = vi.fn(() => true);
      renderTimeline({ onReorder });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 1, 2, 600);
      drop();

      expect(onReorder).toHaveBeenCalledWith(2, 1, true);
    });

    it('marks printers the job may not run on and refuses the drop there', async () => {
      const onReorder = vi.fn(() => true);
      renderTimeline({ onReorder });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 3, 2);
      expect(screen.getByTestId('lane-refusal-3')).toHaveTextContent('queue.timeline.refusal.model {"model":"P1S"}');
      expect(screen.queryByTestId('lane-refusal-1')).toBeNull();
      drop();

      expect(onReorder).not.toHaveBeenCalled();
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
    });

    it('keeps a pinned job on its own lane', async () => {
      const onReorder = vi.fn(() => true);
      renderTimeline({ onReorder });
      const pinnedBar = await within(lane(1)).findByTitle((title) => title.startsWith('Pinned box'));

      drag(pinnedBar, 2, 1);
      expect(screen.getByTestId('lane-refusal-2')).toHaveTextContent('queue.timeline.drop.pinnedElsewhere {"printer":"P1S-01"}');
      drop();

      expect(onReorder).not.toHaveBeenCalled();
    });

    it('opens the details with the printer offered when a job is dropped on an empty lane', async () => {
      const onReorder = vi.fn(() => true);
      renderTimeline({ onReorder, onPinItem: vi.fn() });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 4, 2);
      drop();

      expect(onReorder).not.toHaveBeenCalled();
      const details = screen.getByTestId('queue-job-details');
      expect(within(details).getByRole('combobox')).toHaveValue('4');
    });

    it('does not drag jobs the user may not change, or while the order is not manual', async () => {
      const onReorder = vi.fn(() => true);
      const { unmount } = renderTimeline({ onReorder, canModifyItem: () => false });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      drag(anyBar, 1, 2);
      drop();
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
      unmount();

      renderTimeline({ onReorder, canReorder: false });
      const again = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      drag(again, 1, 2);
      drop();
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
      expect(onReorder).not.toHaveBeenCalled();
      expect(screen.getByText('queue.timeline.legend.sjfHint')).toBeInTheDocument();
    });
  });

  describe('details', () => {
    it('a click opens the job, and pinning is chosen there', async () => {
      const onPinItem = vi.fn();
      renderTimeline({ onReorder: vi.fn(() => true), onPinItem });
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      fireEvent.click(bar('Any tray'));

      const details = screen.getByTestId('queue-job-details');
      expect(within(details).getByText('Any tray')).toBeInTheDocument();
      expect(within(details).getByText('queue.timeline.details.expected {"printer":"P1S-02"}')).toBeInTheDocument();
      // The H2D cannot print a P1S file; the printer it is expected on comes first.
      const select = within(details).getByRole('combobox');
      expect(select).toHaveValue('2');
      expect(within(select).queryByText('H2D-01')).toBeNull();
      fireEvent.change(select, { target: { value: '1' } });
      fireEvent.click(within(details).getByRole('button', { name: /queue\.timeline\.details\.pinButton/ }));

      expect(onPinItem).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), { printer_id: 1 });
      expect(screen.queryByTestId('queue-job-details')).toBeNull();
    });

    it('hands a pinned job back to any printer of its model', async () => {
      const onPinItem = vi.fn();
      renderTimeline({ onPinItem });
      await within(lane(1)).findByTitle((title) => title.startsWith('Pinned box'));

      fireEvent.click(bar('Pinned box'));
      fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.details\.unpin/ }));

      expect(onPinItem).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { target_model: 'P1S' });
    });

    it('edits and removes from the details, and stays read-only without the right', async () => {
      const onEditItem = vi.fn();
      const onCancelItem = vi.fn();
      const { unmount } = renderTimeline({ onEditItem, onCancelItem, onPinItem: vi.fn() });
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      fireEvent.click(bar('Any tray'));
      fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.details\.edit/ }));
      expect(onEditItem).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));

      fireEvent.click(bar('Any tray'));
      fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.details\.cancel/ }));
      expect(onCancelItem).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
      unmount();

      renderTimeline({ onEditItem, onCancelItem, onPinItem: vi.fn(), canModifyItem: () => false });
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      fireEvent.click(bar('Any tray'));
      expect(screen.getByRole('button', { name: /queue\.timeline\.details\.pinButton/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /queue\.timeline\.details\.cancel/ })).toBeDisabled();
    });

    it('closes with Escape', async () => {
      renderTimeline();
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      fireEvent.click(bar('Any tray'));
      expect(screen.getByTestId('queue-job-details')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('queue-job-details')).toBeNull();
    });
  });
});
