/**
 * The timeline draws every pending job where GET /queue/forecast expects the
 * scheduler to run it, "Any <model>" jobs included, and lets a job that has
 * not started be dragged onto another printer the forecast allows (fork).
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
  api: { getQueueForecast: vi.fn() },
}));

const HOUR_MS = 3600 * 1000;

const printers = [
  { id: 1, name: 'P1S-01', model: 'P1S', is_active: true },
  { id: 2, name: 'P1S-02', model: 'P1S', is_active: true },
  { id: 3, name: 'H2D-01', model: 'H2D', is_active: true },
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
const queueItems = [pinned, anyJob, staged];

function iso(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * HOUR_MS).toISOString();
}

function forecast(over: Partial<QueueForecast> = {}): QueueForecast {
  return {
    generated_at: iso(0),
    placements: [
      { item_id: 1, printer_id: 1, start: iso(0), end: iso(1), projected: false },
      { item_id: 2, printer_id: 2, start: iso(0), end: iso(1), projected: true },
    ],
    off_timeline: [{ item_id: 3, reason: 'manual_start', detail: null }],
    printers: [
      { printer_id: 1, free_at: iso(0), available: true, connected: true, external_print: false, awaiting_plate_clear: false },
      { printer_id: 2, free_at: iso(0), available: true, connected: true, external_print: false, awaiting_plate_clear: false },
      { printer_id: 3, free_at: iso(2), available: true, connected: true, external_print: true, awaiting_plate_clear: false },
    ],
    refusals: {
      '1': { '3': { code: 'model', detail: 'P1S' } },
      '2': { '3': { code: 'model', detail: 'P1S' } },
      '3': { '3': { code: 'model', detail: 'P1S' } },
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
        onItemClick={() => {}}
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
    // Give each lane a 56px row, and each bar the top of its lane's row. The
    // drag overlay starts where the dragged bar was, as a browser lays it out.
    let rectSpy: ReturnType<typeof vi.spyOn>;
    let dragFromLane = 1;
    beforeEach(() => {
      rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const laneEl = this.closest('[data-lane]') as HTMLElement | null;
        const index = (laneEl ? Number(laneEl.dataset.lane) : dragFromLane) - 1;
        const isLane = this.hasAttribute('data-lane');
        const top = index * 56 + (isLane ? 0 : 8);
        const height = isLane ? 56 : 40;
        const width = isLane ? 800 : 100;
        return { x: 0, y: top, top, left: 0, right: width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
      });
    });
    afterEach(() => rectSpy.mockRestore());

    function drag(el: HTMLElement, toLane: number, fromLane: number) {
      dragFromLane = fromLane;
      fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: (fromLane - 1) * 56 + 20 });
      act(() => {
        fireEvent.mouseMove(document, { clientX: 20, clientY: (fromLane - 1) * 56 + 20 });
      });
      act(() => {
        fireEvent.mouseMove(document, { clientX: 20, clientY: (toLane - 1) * 56 + 20 });
      });
    }

    it('marks printers the job may not go on, and drops it on one it may', async () => {
      const onMoveItem = vi.fn();
      renderTimeline({ onMoveItem });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 1, 2);
      expect(screen.getByTestId('lane-refusal-3')).toHaveTextContent('queue.timeline.refusal.model {"model":"P1S"}');
      expect(screen.queryByTestId('lane-refusal-1')).toBeNull();
      act(() => {
        fireEvent.mouseUp(document);
      });

      expect(onMoveItem).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), { printer_id: 1 });
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
    });

    it('refuses a drop on a printer the forecast refuses', async () => {
      const onMoveItem = vi.fn();
      renderTimeline({ onMoveItem });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 3, 2);
      act(() => {
        fireEvent.mouseUp(document);
      });

      expect(onMoveItem).not.toHaveBeenCalled();
    });

    it('offers to hand a pinned job back to any printer of its model', async () => {
      renderTimeline({ onMoveItem: vi.fn() });
      const pinnedBar = await within(lane(1)).findByTitle((title) => title.startsWith('Pinned box'));

      drag(pinnedBar, 2, 1);

      expect(screen.getByText('queue.timeline.drop.toAny {"model":"P1S"}')).toBeInTheDocument();
      act(() => {
        fireEvent.mouseUp(document);
      });
    });

    it('does not drag jobs the user may not move', async () => {
      const onMoveItem = vi.fn();
      renderTimeline({ onMoveItem, canMoveItem: () => false });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 1, 2);
      act(() => {
        fireEvent.mouseUp(document);
      });

      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
      expect(onMoveItem).not.toHaveBeenCalled();
    });
  });

  it('a click still opens the job', async () => {
    const onItemClick = vi.fn();
    renderTimeline({ onItemClick, onMoveItem: vi.fn() });
    await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

    fireEvent.click(bar('Any tray'));

    expect(onItemClick).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });
});
