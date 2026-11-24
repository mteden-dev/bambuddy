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
import type { PrintQueueItem, Printer, QueueForecast, QueueStaffedHoursView } from '../../api/client';

vi.mock('../../api/client', () => ({
  api: {
    getQueueForecast: vi.fn(),
    // The details' tag chips; no job asks for tags here.
    getQueueItemTags: vi.fn().mockResolvedValue([]),
    getPrinterTags: vi.fn().mockResolvedValue([]),
    getLibraryTags: vi.fn().mockResolvedValue([]),
    getStaffedHours: vi.fn(),
    updateStaffedHours: vi.fn(),
    getLibraryFileThumbnailUrl: (id: number) => `/thumb/${id}`,
    getLibraryFilePlateThumbnail: (id: number, plate: number) => `/thumb/${id}/plate/${plate}`,
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

  it('shows a job with alternatives as the version its printer takes', async () => {
    const box = job(5, '', {
      archive_name: null,
      target_model: 'P1S',
      print_time_seconds: 3600,
      variants: [
        { library_file_id: 50, filename: 'box_p1s.3mf', target_model: 'P1S', position: 0 },
        { library_file_id: 51, filename: 'box_h2d.3mf', target_model: 'H2D', position: 1 },
      ],
    });
    vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
      placements: [{
        item_id: 5, printer_id: 3, start: iso(2), end: iso(4), projected: true,
        variant: {
          library_file_id: 51, target_model: 'H2D', name: 'Box (H2D)', plate_id: null,
          has_thumbnail: true, print_time_seconds: 7200,
        },
      }],
      off_timeline: [],
    }));
    renderTimeline({ queueItems: [box] });

    const tile = await within(lane(3)).findByTitle((title) => title.startsWith('Box (H2D)'));
    // Its printer's model, not the first alternative's; that file's time and thumbnail.
    expect(tile).toHaveTextContent('queue.filter.any H2D');
    expect(tile).toHaveTextContent('2h');
    expect(tile.querySelector('img')).toHaveAttribute('src', '/thumb/51');
    expect(tile.getAttribute('title')).toContain('queue.filter.any P1S / H2D');

    fireEvent.click(tile);
    const details = screen.getByTestId('queue-job-details');
    expect(within(details).getByRole('heading')).toHaveTextContent('Box (H2D)');
    expect(within(details).getByText('queue.timeline.details.expectedVersion {"printer":"H2D-01","model":"H2D"}'))
      .toBeInTheDocument();
  });

  it('names a job with alternatives off the lanes after its first file', async () => {
    const box = job(5, '', {
      archive_name: null,
      variants: [
        { library_file_id: 51, filename: 'box_h2d.3mf', target_model: 'H2D', position: 1 },
        { library_file_id: 50, filename: 'box_p1s.3mf', target_model: 'P1S', position: 0 },
      ],
    });
    vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
      placements: [],
      off_timeline: [{ item_id: 5, reason: 'manual_start', detail: null }],
    }));
    renderTimeline({ queueItems: [box] });

    expect(await screen.findByTitle((title) => title.startsWith('box_p1s.3mf'))).toBeInTheDocument();
  });

  describe('zoom', () => {
    const widthOf = (el: HTMLElement) => parseFloat(el.style.width.replace(/^max\([^,]+,\s*/, ''));

    it('zooms with the buttons, and the bars grow with it', async () => {
      renderTimeline();
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('24 h');
      const wide = widthOf(anyBar);

      fireEvent.click(screen.getByRole('button', { name: 'queue.timeline.window.zoomIn' }));

      expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('12 h');
      expect(widthOf(bar('Any tray'))).toBeCloseTo(wide * 2, 1);
      expect(localStorage.setItem).toHaveBeenLastCalledWith('queueTimelineZoomHours', '12');

      fireEvent.click(screen.getByRole('button', { name: 'queue.timeline.window.zoomOut' }));
      fireEvent.click(screen.getByRole('button', { name: 'queue.timeline.window.zoomOut' }));
      expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('48 h');
    });

    it('zooms on a trackpad pinch (ctrl + wheel), and a plain wheel only scrolls', async () => {
      renderTimeline();
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      const chart = lane(2).closest('.overflow-x-auto') as HTMLElement;

      fireEvent.wheel(chart, { deltaY: -100 });
      expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('24 h');

      fireEvent.wheel(chart, { deltaY: -100, ctrlKey: true });
      expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('12 h');
      fireEvent.wheel(chart, { deltaY: 100, ctrlKey: true });
      fireEvent.wheel(chart, { deltaY: 100, ctrlKey: true });
      expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('48 h');
    });

    it('remembers the zoom', async () => {
      // The test setup stubs localStorage.
      vi.mocked(localStorage.getItem).mockImplementation((key) => (key === 'queueTimelineZoomHours' ? '8' : null));
      try {
        renderTimeline();
        await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

        expect(screen.getByTestId('timeline-zoom')).toHaveTextContent('8 h');
      } finally {
        vi.mocked(localStorage.getItem).mockReset();
      }
    });
  });

  describe('staffed hours', () => {
    const HOUR = 3600 * 1000;
    // Nobody there from half an hour from now until six hours from now.
    const staffed = (waits = true) => ({
      enabled: true,
      windows: [{ start: iso(-2), end: iso(0.5) }, { start: iso(6), end: iso(18) }],
      clear_minutes: 5,
      waits_for_plate: waits,
    });
    const leftOf = (el: HTMLElement) => parseFloat(el.style.left);
    const pctOf = (ms: number) => ((ms - Math.floor(Date.now() / HOUR) * HOUR) / (24 * HOUR)) * 100;

    it('shades the hours nobody is there and shows a plate waiting to be cleared', async () => {
      vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
        staffed: staffed(),
        plate_waits: [{ printer_id: 2, start: iso(1), end: iso(3) }],
      }));
      renderTimeline();

      const wait = await within(lane(2)).findByTestId('plate-wait-2');
      expect(wait.getAttribute('title')).toContain('queue.timeline.plateWait');
      expect(screen.getAllByTestId('unstaffed').length).toBeGreaterThan(0);
      expect(screen.getByText('queue.timeline.legend.unstaffed')).toBeInTheDocument();
      // In the legend and on the waiting stretch.
      expect(screen.getAllByText('queue.timeline.legend.plateWait').length).toBe(2);
    });

    it('lays out a plan with the night in mind', async () => {
      const shifts = staffed();
      vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({ staffed: shifts }));
      const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const el = this as HTMLElement;
        const laneEl = el.closest('[data-lane]') as HTMLElement | null;
        const index = (laneEl ? Number(laneEl.dataset.lane) : 2) - 1;
        const isLane = el.hasAttribute('data-lane');
        const top = index * 56 + (isLane ? 0 : 8);
        const height = isLane ? 56 : 40;
        const width = isLane ? 800 : 100;
        const left = el.hasAttribute('data-bar-item') ? (parseFloat(el.style.left) / 100) * 800 : 0;
        return { x: left, y: top, top, left, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
      });
      try {
        renderTimeline({ onApplyPlan: vi.fn() });
        const later = await within(lane(2)).findByTitle((title) => title.startsWith('Later cup'));

        // Later cup goes first on printer 2 and ends an hour from now, when
        // nobody is there: Any tray starts once the plate is cleared at six.
        const fromX = later.getBoundingClientRect().left + 10;
        fireEvent.mouseDown(later, { button: 0, clientX: fromX, clientY: 76 });
        act(() => {
          fireEvent.mouseMove(document, { clientX: fromX + 10, clientY: 76 });
        });
        act(() => {
          fireEvent.mouseMove(document, { clientX: 0, clientY: 76 });
        });
        act(() => {
          fireEvent.mouseUp(document);
        });

        const opens = Date.parse(shifts.windows[1].start);
        expect(leftOf(bar('Any tray'))).toBeCloseTo(pctOf(opens + 5 * 60_000), 1);
        expect(within(lane(2)).getAllByTestId('plate-wait-2').length).toBeGreaterThan(0);
      } finally {
        rectSpy.mockRestore();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    });

    it('edits the staffed hours', async () => {
      vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({ staffed: staffed() }));
      const week = Array.from({ length: 7 }, () => ({ start: '07:00', end: '22:00' }));
      vi.mocked(api.getStaffedHours).mockResolvedValue({ enabled: false, timezone: 'UTC', days: week, clear_minutes: 0 } as QueueStaffedHoursView);
      vi.mocked(api.updateStaffedHours).mockImplementation(async (hours) => hours);
      renderTimeline({ canEditStaffedHours: true });

      fireEvent.click(await screen.findByRole('button', { name: /queue\.timeline\.staffed\.button/ }));
      const dialog = await screen.findByTestId('staffed-hours-dialog');
      fireEvent.click(await within(dialog).findByTestId('staffed-tab-week'));
      fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'queue.timeline.staffed.enabled' }));
      fireEvent.click(within(within(dialog).getByTestId('staffed-day-6')).getByRole('checkbox'));
      fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '5' } });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
      });

      expect(api.updateStaffedHours).toHaveBeenCalledWith({
        enabled: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        days: [...week.slice(0, 6), null],
        clear_minutes: 5,
        // Learning is on unless turned off.
        learn: true,
        marks: [],
      });
      expect(screen.queryByTestId('staffed-hours-dialog')).toBeNull();
    });

    it('is read-only without the right, and says when it changes nothing', async () => {
      vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({ staffed: staffed(false) }));
      const week = Array.from({ length: 7 }, () => ({ start: '07:00', end: '22:00' }));
      vi.mocked(api.getStaffedHours).mockResolvedValue({ enabled: true, timezone: 'Europe/Warsaw', days: week, clear_minutes: 5, learn: true });
      renderTimeline();
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.staffed\.button/ }));
      const dialog = await screen.findByTestId('staffed-hours-dialog');

      expect(await within(dialog).findByTestId('staffed-no-plate-clear')).toBeInTheDocument();
      // Nothing to paint with on the calendar, nothing to change in the week.
      expect(within(dialog).getByTestId('staffed-calendar')).toBeInTheDocument();
      expect(within(dialog).queryByTestId('staffed-brush-away')).toBeNull();
      fireEvent.click(within(dialog).getByTestId('staffed-tab-week'));
      expect(within(dialog).getByRole('checkbox', { name: 'queue.timeline.staffed.enabled' })).toBeDisabled();
      expect(within(dialog).queryByRole('button', { name: 'common.save' })).toBeNull();
    });

    describe('marked for given dates', () => {
      const typicalStart = () => new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString();

      it('shows the marked stretches on the lanes, the axis and the legend', async () => {
        vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
          staffed: {
            enabled: false,
            windows: [{ start: iso(-24), end: iso(-1) }, { start: iso(3), end: iso(24 * 14) }],
            marks: [
              { start: iso(-1), end: iso(3), kind: 'away' },
              { start: iso(8), end: iso(10), kind: 'here' },
            ],
            clear_minutes: 5,
            waits_for_plate: true,
          },
          plate_waits: [{ printer_id: 2, start: iso(1), end: iso(3.1), reason: 'absent' }],
        }));
        renderTimeline();

        const wait = await within(lane(2)).findByTestId('plate-wait-2');
        expect(wait).toHaveTextContent('queue.timeline.plateAbsent');
        expect(wait.getAttribute('title')).toContain('queue.timeline.plateWaitAbsent');
        expect(screen.getAllByTestId('marked-away')).toHaveLength(1);
        expect(screen.getAllByTestId('axis-mark').map((m) => m.dataset.kind)).toEqual(['away', 'here']);
        expect(screen.getByTestId('legend-absent')).toBeInTheDocument();
        expect(screen.getByTestId('legend-here')).toBeInTheDocument();
        // The weekly hours are not used.
        expect(screen.queryByText('queue.timeline.legend.unstaffed')).toBeNull();

        // Nobody is there now, as marked: says until when, and opens the calendar.
        fireEvent.click(screen.getByTestId('timeline-marked-away'));
        expect(await screen.findByTestId('staffed-hours-dialog')).toBeInTheDocument();
      });

      it('lays out a plan going by a marked absence, not by the usual wait', async () => {
        // Plates usually wait ten hours; nobody is there, as marked, until six hours from now.
        const back = iso(6);
        vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
          staffed: {
            enabled: false,
            windows: [{ start: iso(-24), end: iso(0.5) }, { start: back, end: iso(24 * 14) }],
            marks: [{ start: iso(0.5), end: back, kind: 'away' }],
            clear_minutes: 5,
            waits_for_plate: true,
            learn: true,
            learned_samples: 40,
            typical: { start: typicalStart(), minutes: Array(168).fill(600) },
          },
        }));
        const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const el = this as HTMLElement;
          const laneEl = el.closest('[data-lane]') as HTMLElement | null;
          const index = (laneEl ? Number(laneEl.dataset.lane) : 2) - 1;
          const isLane = el.hasAttribute('data-lane');
          const top = index * 56 + (isLane ? 0 : 8);
          const height = isLane ? 56 : 40;
          const width = isLane ? 800 : 100;
          const left = el.hasAttribute('data-bar-item') ? (parseFloat(el.style.left) / 100) * 800 : 0;
          return { x: left, y: top, top, left, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
        });
        try {
          renderTimeline({ onApplyPlan: vi.fn() });
          const later = await within(lane(2)).findByTitle((title) => title.startsWith('Later cup'));

          // Later cup goes first on printer 2 and ends an hour from now, in
          // the marked absence: Any tray starts once someone is back at six.
          const fromX = later.getBoundingClientRect().left + 10;
          fireEvent.mouseDown(later, { button: 0, clientX: fromX, clientY: 76 });
          act(() => {
            fireEvent.mouseMove(document, { clientX: fromX + 10, clientY: 76 });
          });
          act(() => {
            fireEvent.mouseMove(document, { clientX: 0, clientY: 76 });
          });
          act(() => {
            fireEvent.mouseUp(document);
          });

          expect(leftOf(bar('Any tray'))).toBeCloseTo(pctOf(Date.parse(back) + 5 * 60_000), 1);
          const wait = within(lane(2)).getAllByTestId('plate-wait-2')[0];
          expect(wait).toHaveAttribute('data-reason', 'absent');
        } finally {
          rectSpy.mockRestore();
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      });
    });

    describe('waiting for a manual start', () => {
      // Nobody is expected to press Start for five hours.
      const rule = {
        enabled: false,
        windows: [],
        clear_minutes: 0,
        waits_for_plate: false,
        someone_there_at: iso(5),
        someone_there_reason: 'unstaffed' as const,
      };
      const onLane2 = (start: number) => forecast({
        staffed: rule,
        placements: [
          { item_id: 1, printer_id: 1, start: iso(0), end: iso(1), projected: false },
          { item_id: 2, printer_id: 2, start: iso(0), end: iso(1), projected: true },
          { item_id: 4, printer_id: 2, start: iso(3), end: iso(4), projected: true },
          { item_id: 3, printer_id: 2, start: iso(start), end: iso(start + 1), projected: true },
        ],
        off_timeline: [],
      });

      it('goes on its lane, marked as waiting for someone to press Start', async () => {
        vi.mocked(api.getQueueForecast).mockResolvedValue(onLane2(5));
        const items = [pinned, anyJob, { ...staged, waiting_reason: 'Load PETG' }, laterJob];
        renderTimeline({ queueItems: items });

        const staging = await within(lane(2)).findByTitle((title) => title.startsWith('Staged lid'));
        expect(staging).toHaveAttribute('data-manual', 'true');
        expect(staging).toHaveTextContent('queue.timeline.manualStart');
        expect(staging.getAttribute('title')).toContain('queue.timeline.manualStartHelp: Load PETG');
        expect(screen.getByTestId('legend-manual')).toHaveTextContent('queue.timeline.legend.manual');
        expect(screen.queryByText(/queue\.timeline\.offTimeline\.title/)).not.toBeInTheDocument();
        // A job that starts by itself carries no such mark.
        expect(within(lane(2)).getByTitle((title) => title.startsWith('Any tray'))).not.toHaveAttribute('data-manual');
      });

      it('stays after the time someone is expected in a plan', async () => {
        // Drawn later than that by the forecast, so the plan's own replay shows.
        vi.mocked(api.getQueueForecast).mockResolvedValue(onLane2(7));
        const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const el = this as HTMLElement;
          const laneEl = el.closest('[data-lane]') as HTMLElement | null;
          const index = (laneEl ? Number(laneEl.dataset.lane) : 2) - 1;
          const isLane = el.hasAttribute('data-lane');
          const top = index * 56 + (isLane ? 0 : 8);
          const height = isLane ? 56 : 40;
          const width = isLane ? 800 : 100;
          const left = el.hasAttribute('data-bar-item') ? (parseFloat(el.style.left) / 100) * 800 : 0;
          return { x: left, y: top, top, left, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
        });
        try {
          renderTimeline({ onApplyPlan: vi.fn() });
          const later = await within(lane(2)).findByTitle((title) => title.startsWith('Later cup'));

          // Later cup goes first on printer 2: it and Any tray are done in two
          // hours, and the staged lid waits for someone at five.
          const fromX = later.getBoundingClientRect().left + 10;
          fireEvent.mouseDown(later, { button: 0, clientX: fromX, clientY: 76 });
          act(() => {
            fireEvent.mouseMove(document, { clientX: fromX + 10, clientY: 76 });
          });
          act(() => {
            fireEvent.mouseMove(document, { clientX: 0, clientY: 76 });
          });
          act(() => {
            fireEvent.mouseUp(document);
          });

          expect(leftOf(bar('Any tray'))).toBeCloseTo(pctOf(Date.now() + HOUR), 0);
          expect(leftOf(bar('Staged lid'))).toBeCloseTo(pctOf(Date.parse(rule.someone_there_at)), 1);
        } finally {
          rectSpy.mockRestore();
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      });
    });

    describe('learned from how long plates wait', () => {
      const learnedRule = (over: Record<string, unknown> = {}) => ({
        enabled: false,
        windows: [],
        clear_minutes: 5,
        waits_for_plate: true,
        learn: true,
        learned_samples: 40,
        typical: { start: new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString(), minutes: Array(168).fill(120) },
        away_until: null,
        present_until: null,
        ...over,
      });

      it('says why a plate waits, and when nobody seems to be there', async () => {
        vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
          staffed: learnedRule({ away_until: iso(2) }),
          plate_waits: [
            { printer_id: 1, start: iso(-1.5), end: iso(2), reason: 'away' },
            { printer_id: 2, start: iso(1), end: iso(3), reason: 'typical' },
          ],
        }));
        renderTimeline();

        const typical = await within(lane(2)).findByTestId('plate-wait-2');
        expect(typical).toHaveAttribute('data-reason', 'typical');
        expect(typical.getAttribute('title')).toContain('queue.timeline.plateWaitTypical');
        const away = within(lane(1)).getByTestId('plate-wait-1');
        expect(away).toHaveAttribute('data-reason', 'away');
        expect(away.getAttribute('title')).toContain('queue.timeline.plateWaitAway ');
        expect(away).toHaveTextContent('queue.timeline.plateAway');
        expect(screen.getByTestId('timeline-away')).toHaveTextContent('queue.timeline.away');
      });

      it('lays out a plan with the usual wait, and with nobody there', async () => {
        vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({ staffed: learnedRule() }));
        const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const el = this as HTMLElement;
          const laneEl = el.closest('[data-lane]') as HTMLElement | null;
          const index = (laneEl ? Number(laneEl.dataset.lane) : 2) - 1;
          const isLane = el.hasAttribute('data-lane');
          const top = index * 56 + (isLane ? 0 : 8);
          const height = isLane ? 56 : 40;
          const width = isLane ? 800 : 100;
          const left = el.hasAttribute('data-bar-item') ? (parseFloat(el.style.left) / 100) * 800 : 0;
          return { x: left, y: top, top, left, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
        });
        try {
          renderTimeline({ onApplyPlan: vi.fn() });
          const later = await within(lane(2)).findByTitle((title) => title.startsWith('Later cup'));

          // Later cup goes first on printer 2 and ends an hour from now;
          // plates usually wait two hours then, so Any tray starts at three.
          const fromX = later.getBoundingClientRect().left + 10;
          fireEvent.mouseDown(later, { button: 0, clientX: fromX, clientY: 76 });
          act(() => {
            fireEvent.mouseMove(document, { clientX: fromX + 10, clientY: 76 });
          });
          act(() => {
            fireEvent.mouseMove(document, { clientX: 0, clientY: 76 });
          });
          act(() => {
            fireEvent.mouseUp(document);
          });

          expect(leftOf(bar('Any tray'))).toBeCloseTo(pctOf(Date.now() + 3 * HOUR), 0);
          const wait = within(lane(2)).getAllByTestId('plate-wait-2')[0];
          expect(wait).toHaveAttribute('data-reason', 'typical');
        } finally {
          rectSpy.mockRestore();
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      });

      it('shows what it learned and turns learning off', async () => {
        vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({ staffed: learnedRule({ away_until: iso(2) }) }));
        const week = Array.from({ length: 7 }, () => ({ start: '07:00', end: '22:00' }));
        vi.mocked(api.getStaffedHours).mockResolvedValue({
          enabled: false,
          timezone: 'Europe/Warsaw',
          days: week,
          clear_minutes: 5,
          learn: true,
          learned: { samples: 40, needed: 10, typical_minutes: Array.from({ length: 168 }, (_, i) => (i % 24 < 7 ? 480 : 20)) },
        });
        vi.mocked(api.updateStaffedHours).mockImplementation(async (hours) => hours);
        renderTimeline({ canEditStaffedHours: true });

        fireEvent.click(await screen.findByRole('button', { name: /queue\.timeline\.staffed\.button/ }));
        const dialog = await screen.findByTestId('staffed-hours-dialog');
        fireEvent.click(await within(dialog).findByTestId('staffed-tab-week'));
        const heatmap = await within(dialog).findByTestId('staffed-heatmap');
        expect(heatmap.querySelectorAll('[title]').length).toBe(168);
        expect(within(dialog).getByTestId('staffed-now')).toHaveTextContent('queue.timeline.staffed.nowAway');

        fireEvent.click(within(dialog).getByRole('checkbox', { name: /queue\.timeline\.staffed\.learn/ }));
        expect(within(dialog).queryByTestId('staffed-heatmap')).toBeNull();
        await act(async () => {
          fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
        });

        expect(api.updateStaffedHours).toHaveBeenCalledWith(expect.objectContaining({ learn: false }));
      });

      it('says when there is too little to learn from yet', async () => {
        vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({ staffed: learnedRule({ typical: null }) }));
        const week = Array.from({ length: 7 }, () => ({ start: '07:00', end: '22:00' }));
        vi.mocked(api.getStaffedHours).mockResolvedValue({
          enabled: false,
          timezone: 'Europe/Warsaw',
          days: week,
          clear_minutes: 5,
          learn: true,
          learned: { samples: 3, needed: 10, typical_minutes: null },
        });
        renderTimeline();

        fireEvent.click(await screen.findByRole('button', { name: /queue\.timeline\.staffed\.button/ }));
        const dialog = await screen.findByTestId('staffed-hours-dialog');
        fireEvent.click(await within(dialog).findByTestId('staffed-tab-week'));

        expect(await within(dialog).findByTestId('staffed-too-few')).toHaveTextContent('"count":3');
      });
    });
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
    afterEach(async () => {
      rectSpy.mockRestore();
      // Let dnd-kit's guard against a click right after a drop run out before the next test.
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

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

    // dnd-kit swallows clicks for a moment after a drop (so the drop is no click).
    async function afterDrop() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
    }

    const applied = { reserved: [], moved_elsewhere: [] };
    const leftOf = (el: HTMLElement) => parseFloat(el.style.left);

    it('lays a job into the gap in a plan, and saves nothing until it is applied', async () => {
      const onApplyPlan = vi.fn().mockResolvedValue(applied);
      const onPinItem = vi.fn();
      renderTimeline({ onApplyPlan, onPinItem });
      const later = await within(lane(2)).findByTitle((title) => title.startsWith('Later cup'));

      drag(later, 2, 2, 0);
      expect(screen.getByTestId('drop-marker-2')).toBeInTheDocument();
      drop();

      expect(onApplyPlan).not.toHaveBeenCalled();
      expect(onPinItem).not.toHaveBeenCalled();
      expect(screen.getByTestId('timeline-plan-bar')).toHaveTextContent('queue.timeline.plan.unsaved {"count":1}');
      // First on its lane now, held for that printer once applied; the job it passed moves along.
      const moved = bar('Later cup');
      expect(moved).toHaveAttribute('data-moved', 'true');
      expect(moved).toHaveAttribute('data-kind', 'reserved');
      expect(leftOf(moved)).toBeLessThan(leftOf(bar('Any tray')));
      expect(bar('Pinned box')).toHaveAttribute('data-kind', 'pinned');

      await afterDrop();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.plan\.apply/ }));
      });

      expect(onApplyPlan).toHaveBeenCalledWith({
        lanes: [
          { printer_id: 1, item_ids: [1] },
          { printer_id: 2, item_ids: [4, 2] },
          { printer_id: 3, item_ids: [] },
          { printer_id: 4, item_ids: [] },
        ],
        reserve: [4],
      });
      expect(screen.queryByTestId('timeline-plan-bar')).toBeNull();
    });

    it('moves an "Any" job onto another printer, and nothing else moves', async () => {
      const onApplyPlan = vi.fn().mockResolvedValue(applied);
      renderTimeline({ onApplyPlan });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      const laterBefore = leftOf(bar('Later cup'));

      drag(anyBar, 4, 2);
      drop();

      expect(within(lane(4)).getByTitle((title) => title.startsWith('Any tray'))).toBeInTheDocument();
      expect(within(lane(2)).queryByTitle((title) => title.startsWith('Any tray'))).toBeNull();
      // Lane 2's next job moves up into the freed time; lane 1 stays as it was.
      expect(leftOf(bar('Later cup'))).toBeLessThan(laterBefore);
      await afterDrop();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.plan\.apply/ }));
      });
      expect(onApplyPlan).toHaveBeenCalledWith(expect.objectContaining({
        lanes: expect.arrayContaining([{ printer_id: 4, item_ids: [2] }, { printer_id: 2, item_ids: [4] }]),
        reserve: [2],
      }));
    });

    it('undoes a move and drops the plan', async () => {
      renderTimeline({ onApplyPlan: vi.fn().mockResolvedValue(applied) });
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(bar('Any tray'), 4, 2);
      drop();
      drag(bar('Later cup'), 4, 2, 600);
      drop();
      expect(screen.getByTestId('timeline-plan-bar')).toHaveTextContent('{"count":2}');

      await afterDrop();
      fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.plan\.undo/ }));
      expect(screen.getByTestId('timeline-plan-bar')).toHaveTextContent('{"count":1}');
      expect(within(lane(2)).getByTitle((title) => title.startsWith('Later cup'))).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.plan\.discard/ }));
      expect(screen.queryByTestId('timeline-plan-bar')).toBeNull();
      expect(within(lane(2)).getByTitle((title) => title.startsWith('Any tray'))).toBeInTheDocument();
    });

    it('keeps the plan when it could not be applied', async () => {
      const onApplyPlan = vi.fn().mockRejectedValue(new Error('nope'));
      renderTimeline({ onApplyPlan });
      await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      drag(bar('Any tray'), 4, 2);
      drop();

      await afterDrop();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /queue\.timeline\.plan\.apply/ }));
      });

      expect(screen.getByTestId('timeline-plan-bar')).toBeInTheDocument();
    });

    it('marks printers an "Any" job may not wait for and refuses the drop there', async () => {
      vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
        reserve_refusals: { '2': { '3': { code: 'model', detail: 'P1S' }, '4': { code: 'offline', detail: null } } },
      }));
      const onApplyPlan = vi.fn().mockResolvedValue(applied);
      renderTimeline({ onApplyPlan });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));

      drag(anyBar, 3, 2);
      expect(screen.getByTestId('lane-refusal-3')).toHaveTextContent('queue.timeline.refusal.model {"model":"P1S"}');
      expect(screen.getByTestId('lane-refusal-4')).toHaveTextContent('queue.timeline.refusal.offline');
      expect(screen.queryByTestId('lane-refusal-1')).toBeNull();
      drop();

      expect(screen.queryByTestId('timeline-plan-bar')).toBeNull();
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
    });

    it('keeps a pinned job on its own lane', async () => {
      renderTimeline({ onApplyPlan: vi.fn() });
      const pinnedBar = await within(lane(1)).findByTitle((title) => title.startsWith('Pinned box'));

      drag(pinnedBar, 2, 1);
      expect(screen.getByTestId('lane-refusal-2')).toHaveTextContent('queue.timeline.drop.pinnedElsewhere {"printer":"P1S-01"}');
      drop();

      expect(screen.queryByTestId('timeline-plan-bar')).toBeNull();
    });

    it('does not drag jobs the user may not change, or while the order is not manual', async () => {
      const { unmount } = renderTimeline({ onApplyPlan: vi.fn(), canModifyItem: () => false });
      const anyBar = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      drag(anyBar, 1, 2);
      drop();
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
      unmount();

      renderTimeline({ onApplyPlan: vi.fn(), canReorder: false });
      const again = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      drag(again, 1, 2);
      drop();
      expect(screen.queryByTestId('lane-refusal-3')).toBeNull();
      expect(screen.queryByTestId('timeline-plan-bar')).toBeNull();
      expect(screen.getByText('queue.timeline.legend.sjfHint')).toBeInTheDocument();
    });
  });

  describe('details', () => {
    it('a click opens the job, and pinning is chosen there', async () => {
      const onPinItem = vi.fn();
      renderTimeline({ onApplyPlan: vi.fn(), onPinItem });
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

    it('shows a job the plan reserved, and releases it from its details', async () => {
      vi.mocked(api.getQueueForecast).mockResolvedValue(forecast({
        placements: [
          { item_id: 1, printer_id: 1, start: iso(0), end: iso(1), projected: false },
          { item_id: 2, printer_id: 2, start: iso(0), end: iso(1), projected: true, reserved: true },
          { item_id: 4, printer_id: 2, start: iso(3), end: iso(4), projected: true },
        ],
        reservations: { '2': { printer_id: 2, active: true } },
      }));
      const onReleaseReservation = vi.fn();
      renderTimeline({ onReleaseReservation, onPinItem: vi.fn() });
      const tile = await within(lane(2)).findByTitle((title) => title.startsWith('Any tray'));
      expect(tile).toHaveAttribute('data-kind', 'reserved');

      fireEvent.click(tile);
      const reservation = screen.getByTestId('queue-job-reservation');
      expect(reservation).toHaveTextContent('queue.timeline.details.reserved {"printer":"P1S-02"}');
      expect(reservation).toHaveTextContent('queue.timeline.details.reservedHelp');
      fireEvent.click(within(reservation).getByRole('button', { name: /queue\.timeline\.details\.release/ }));

      expect(onReleaseReservation).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
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
