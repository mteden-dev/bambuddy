/**
 * Fork (products): finished prints to check, and the question before a plate is cleared.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProductQcView } from '../../components/products/ProductQc';
import { usePlateClearQc } from '../../hooks/usePlateClearQc';
import type { ProductQcJob } from '../../api/client';

const JOB: ProductQcJob = {
  id: 7,
  product_id: 4,
  product_name: '9mm 100 Black',
  printer_id: 1,
  printer_name: 'P1S-A',
  library_file_id: 10,
  filename: '9mm_gora_x3_P1S.gcode.3mf',
  archive_id: null,
  finished_at: '2026-11-24T10:00:00Z',
  checked_at: null,
  pieces: [{ part_id: 41, part_name: 'Lid', pieces: 3, rejected: 0 }],
};

let jobs: ProductQcJob[];
let checkedJobs: ProductQcJob[];
let checks: { id: number; body: unknown }[];
let unchecks: number[];

beforeEach(() => {
  jobs = [JOB];
  checkedJobs = [];
  checks = [];
  unchecks = [];
  server.use(
    http.get('/api/v1/products/qc', ({ request }) =>
      HttpResponse.json(new URL(request.url).searchParams.get('checked') ? checkedJobs : jobs),
    ),
    http.post('/api/v1/products/jobs/:id/uncheck', ({ params }) => {
      unchecks.push(Number(params.id));
      return HttpResponse.json({ job: JOB, replanned: false, reopened_orders: [] });
    }),
    http.post('/api/v1/products/jobs/:id/check', async ({ params, request }) => {
      const body = (await request.json()) as { rejected: { pieces: number }[] };
      checks.push({ id: Number(params.id), body });
      return HttpResponse.json({ job: { ...JOB, checked_at: '2026-11-24T11:00:00Z' }, replanned: body.rejected.length > 0, reopened_orders: [] });
    }),
  );
});

const allowAll = () => true;

describe('ProductQcView', () => {
  it('lists a finished print, marks it all good and can take it back', async () => {
    const user = userEvent.setup();
    render(<ProductQcView hasPermission={allowAll} />);
    expect(await screen.findByText('9mm 100 Black')).toBeInTheDocument();
    expect(screen.getByText('Lid: 3 pcs')).toBeInTheDocument();
    expect(screen.getByText('P1S-A')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All good' }));
    await waitFor(() => expect(checks).toEqual([{ id: 7, body: { rejected: [], source: 'dialog' } }]));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(unchecks).toEqual([7]));
  });

  it('saves the bad pieces with one tap per count', async () => {
    const user = userEvent.setup();
    render(<ProductQcView hasPermission={allowAll} />);
    const bad = await screen.findByRole('radiogroup', { name: 'Bad pieces of Lid' });
    await user.click(within(bad).getByRole('radio', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'Save bad pieces' }));
    await waitFor(() =>
      expect(checks).toEqual([{ id: 7, body: { rejected: [{ part_id: 41, pieces: 1 }], source: 'dialog' } }]),
    );
  });

  it('shows the prints checked lately, to correct an answer', async () => {
    checkedJobs = [
      { ...JOB, checked_at: '2026-11-24T11:00:00Z', pieces: [{ part_id: 41, part_name: 'Lid', pieces: 3, rejected: 1 }] },
    ];
    const user = userEvent.setup();
    render(<ProductQcView hasPermission={allowAll} />);
    await user.click(await screen.findByRole('tab', { name: 'Checked' }));
    expect(await screen.findByText('Bad: Lid 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Correct' }));
    const bad = screen.getByRole('radiogroup', { name: 'Bad pieces of Lid' });
    expect(within(bad).getByRole('radio', { name: '1' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(bad).getByRole('radio', { name: '0' }));
    await user.click(screen.getByRole('button', { name: 'All good' }));
    await waitFor(() => expect(checks).toEqual([{ id: 7, body: { rejected: [], source: 'dialog' } }]));
  });

  it('a failed load is an error, not an empty list', async () => {
    server.use(http.get('/api/v1/products/qc', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<ProductQcView hasPermission={allowAll} />);
    expect(await screen.findByText('Could not load the list.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing to check.')).not.toBeInTheDocument();
  });

  it('says when there is nothing to check', async () => {
    jobs = [];
    render(<ProductQcView hasPermission={allowAll} />);
    expect(await screen.findByText('Nothing to check.')).toBeInTheDocument();
  });
});

function ClearButton({ onClear }: { onClear: () => void }) {
  const qc = usePlateClearQc(1, 'P1S-A', true);
  return (
    <>
      <button type="button" onClick={() => qc.beforeClear(onClear)} disabled={qc.checking}>
        Plate cleared
      </button>
      {qc.badge}
      {qc.modal}
    </>
  );
}

describe('usePlateClearQc', () => {
  it('clears at once when nothing waits to be checked', async () => {
    jobs = [];
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<ClearButton onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Plate cleared' }));
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
  });

  it('asks first, and "check later" clears without checking', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<ClearButton onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Plate cleared' }));
    expect(await screen.findByRole('dialog', { name: 'P1S-A: is the print good?' })).toBeInTheDocument();
    expect(onClear).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check later · plate cleared' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(checks).toEqual([]);
  });

  it('records the answer, then clears', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<ClearButton onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Plate cleared' }));
    await user.click(await screen.findByRole('button', { name: 'All good · plate cleared' }));
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(checks).toEqual([{ id: 7, body: { rejected: [], source: 'plate_clear' } }]);
  });

  it('closing the question clears nothing', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<ClearButton onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Plate cleared' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel (plate stays)' }));
    expect(onClear).not.toHaveBeenCalled();
  });

  it('only the plate on the printer is asked about; older ones are counted', async () => {
    const older = { ...JOB, id: 6, finished_at: '2026-11-24T08:00:00Z' };
    jobs = [JOB, older];
    server.use(
      http.get('/api/v1/products/qc', ({ request }) =>
        HttpResponse.json(new URL(request.url).searchParams.get('on_plate') ? [JOB] : jobs),
      ),
    );
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<ClearButton onClear={onClear} />);
    expect(await screen.findByRole('button', { name: 'to check: 2' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Plate cleared' }));
    expect(await screen.findByText('Older prints set aside, under To check: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All good · plate cleared' }));
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(checks).toEqual([{ id: 7, body: { rejected: [], source: 'plate_clear' } }]);
  });

  it('the badge opens the printer\'s list without clearing the plate', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<ClearButton onClear={onClear} />);
    await user.click(await screen.findByRole('button', { name: 'to check: 1' }));
    expect(await screen.findByRole('dialog', { name: 'P1S-A: prints to check' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All good' }));
    await waitFor(() => expect(checks).toEqual([{ id: 7, body: { rejected: [], source: 'dialog' } }]));
    expect(onClear).not.toHaveBeenCalled();
  });
});
