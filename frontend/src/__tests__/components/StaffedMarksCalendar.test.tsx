import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { StaffedMarksCalendar } from '../../components/StaffedMarksCalendar';
import type { QueueStaffedMark } from '../../api/client';

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key);
const week = Array.from({ length: 7 }, () => ({ start: '07:00', end: '22:00' }));
// The grid: 24 hours over 240 px, 14 rows of 28 px.
const HOUR_PX = 10;
const ROW_PX = 28;

const away = (start: string, end: string): QueueStaffedMark => ({
  start: `2026-11-${start}`,
  end: `2026-11-${end}`,
  kind: 'away',
});

function renderCalendar(marks: QueueStaffedMark[] = [], readOnly = false) {
  const onChange = vi.fn();
  render(
    <StaffedMarksCalendar
      marks={marks}
      onChange={onChange}
      timezone="UTC"
      days={week}
      weeklyEnabled
      readOnly={readOnly}
      t={t}
    />,
  );
  return onChange;
}

/** Drag over the grid from (row, hour) to (row, hour). */
function drag(from: [number, number], to: [number, number]) {
  const grid = screen.getByTestId('staffed-calendar-grid');
  const point = ([row, hour]: [number, number]) => ({
    pointerId: 1,
    pointerType: 'touch',
    clientX: hour * HOUR_PX,
    clientY: row * ROW_PX + ROW_PX / 2,
  });
  fireEvent.pointerDown(grid, point(from));
  if (from[0] !== to[0] || from[1] !== to[1]) fireEvent.pointerMove(grid, point(to));
  fireEvent.pointerUp(grid, point(to));
}

// jsdom has no PointerEvent, and testing-library then falls back to a plain
// Event without the pointer's position.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
  }
}

describe('StaffedMarksCalendar', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: FakePointerEvent });
    vi.useFakeTimers({ toFake: ['Date'] });
    // Tuesday 24 November 2026, 09:00.
    vi.setSystemTime(new Date('2026-11-24T09:00:00Z'));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = 24 * HOUR_PX;
      const height = 14 * ROW_PX;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    });
  });

  afterEach(() => {
    delete (window as { PointerEvent?: unknown }).PointerEvent;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows two weeks from today, the weekly hours behind', () => {
    renderCalendar();

    expect(screen.getAllByTestId(/^staffed-calendar-day-/)).toHaveLength(14);
    expect(screen.getByText('queue.timeline.staffed.today')).toBeInTheDocument();
    expect(screen.getByText('queue.timeline.staffed.legendWeekOff')).toBeInTheDocument();
    expect(screen.getByTestId('staffed-no-marks')).toBeInTheDocument();
  });

  it('marks the hours dragged over as nobody there', () => {
    const onChange = renderCalendar();

    drag([0, 0], [0, 8]);

    expect(onChange).toHaveBeenCalledWith([away('24T00:00', '24T08:00')]);
  });

  it('marks across midnight into the next day', () => {
    const onChange = renderCalendar();

    drag([1, 23], [2, 6]);

    expect(onChange).toHaveBeenCalledWith([away('25T23:00', '26T06:00')]);
  });

  it('marks the hour tapped, with the brush chosen', () => {
    const onChange = renderCalendar();

    fireEvent.click(screen.getByTestId('staffed-brush-here'));
    drag([6, 12.4], [6, 12.4]);

    expect(onChange).toHaveBeenCalledWith([{ start: '2026-11-30T12:00', end: '2026-11-30T13:00', kind: 'here' }]);
  });

  it('clears what is dragged over with the eraser', () => {
    const onChange = renderCalendar([away('24T00:00', '24T08:00')]);

    fireEvent.click(screen.getByTestId('staffed-brush-erase'));
    drag([0, 4], [0, 9]);

    expect(onChange).toHaveBeenCalledWith([away('24T00:00', '24T04:00')]);
  });

  it('lists the marks to set to the minute, switch or remove', () => {
    const marks = [away('24T22:00', '25T06:00'), { ...away('27T10:00', '27T14:00'), kind: 'here' as const }];
    const onChange = renderCalendar(marks);

    const rows = screen.getAllByTestId('staffed-mark-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('staffed-mark').map((m) => m.dataset.kind)).toEqual(['away', 'away', 'here']);

    // Coming back an hour later.
    fireEvent.change(within(rows[0]).getByLabelText('queue.timeline.staffed.to'), { target: { value: '2026-11-25T07:00' } });
    expect(onChange).toHaveBeenLastCalledWith([away('24T22:00', '25T07:00'), marks[1]]);
    // Moving the start moves the whole stretch.
    fireEvent.change(within(rows[0]).getByLabelText('queue.timeline.staffed.from'), { target: { value: '2026-11-24T23:00' } });
    expect(onChange).toHaveBeenLastCalledWith([away('24T23:00', '25T07:00'), marks[1]]);
    // An end before the start is not taken.
    onChange.mockClear();
    fireEvent.change(within(rows[0]).getByLabelText('queue.timeline.staffed.to'), { target: { value: '2026-11-24T20:00' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(within(rows[1]).getByRole('button', { name: /queue\.timeline\.staffed\.brushHere/ }));
    expect(onChange).toHaveBeenLastCalledWith([marks[0], away('27T10:00', '27T14:00')]);
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'queue.timeline.staffed.removeMark' }));
    expect(onChange).toHaveBeenLastCalledWith([marks[1]]);
  });

  it('leaves out marks that are over', () => {
    renderCalendar([away('24T00:00', '24T08:00'), away('24T10:00', '24T12:00')]);

    expect(screen.getAllByTestId('staffed-mark-row')).toHaveLength(1);
  });

  it('changes nothing read-only', () => {
    const onChange = renderCalendar([away('24T10:00', '24T12:00')], true);

    expect(screen.queryByTestId('staffed-brush-away')).toBeNull();
    drag([0, 0], [0, 8]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'queue.timeline.staffed.removeMark' })).toBeNull();
  });
});
