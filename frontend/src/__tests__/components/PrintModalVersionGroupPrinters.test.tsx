/**
 * Fork: printing a version group on chosen printers.
 *
 * A version group (one print sliced for several printer models) used to open
 * only as printer alternatives: one job for the first free printer, with no
 * way to pick the printer or the version. The dialog now offers "First free
 * printer" (the alternatives, where a version can be left out) and "Chosen
 * printers": the picker lists the printers a version fits, and each chosen
 * printer gets its own queue item with the version sliced for its model.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintModal } from '../../components/PrintModal';
import type { VariantCandidate } from '../../components/PrintModal/VariantCandidates';
import { versionForModel } from '../../components/PrintModal/multiFile';
import { queueSeparateJobs } from '../../components/PrintModal/separateJobs';

const BOTTOM_P1S: VariantCandidate = { id: 21, filename: 'bottom.gcode.3mf', sliced_for_model: 'P1S' };
const BOTTOM_H2S: VariantCandidate = { id: 22, filename: 'H2S.bottom.gcode.3mf', sliced_for_model: 'H2S' };
const BY_ID: Record<number, VariantCandidate> = { 21: BOTTOM_P1S, 22: BOTTOM_H2S };

const PRINTERS = [
  { id: 1, name: 'P1S One', model: 'P1S', ip_address: '192.0.2.1', is_active: true, enabled: true },
  { id: 2, name: 'P1S Two', model: 'P1S', ip_address: '192.0.2.2', is_active: true, enabled: true },
  { id: 3, name: 'H2S Big', model: 'H2S', ip_address: '192.0.2.3', is_active: true, enabled: true },
  { id: 4, name: 'P1P Old', model: 'P1P', ip_address: '192.0.2.4', is_active: true, enabled: true },
  { id: 5, name: 'A1 Mini', model: 'A1 Mini', ip_address: '192.0.2.5', is_active: true, enabled: true },
];

type Body = Record<string, unknown>;
let posted: Body[];
// Answers each POST; the index counts every POST of the test, refused ones too.
let reply: (body: Body, index: number) => Response;
let postCount: number;

function mockBackend() {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(PRINTERS)),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] }),
    ),
    http.get('/api/v1/printers/available-filaments', () => HttpResponse.json([])),
    http.get('/api/v1/library/files/:id', ({ params }) => {
      const file = BY_ID[Number(params.id)];
      return HttpResponse.json({
        id: file.id,
        filename: file.filename,
        file_type: 'gcode.3mf',
        sliced_for_model: file.sliced_for_model,
      });
    }),
    http.get('/api/v1/library/files/:id/plates', ({ params }) =>
      HttpResponse.json({ file_id: Number(params.id), filename: 'x', plates: [], is_multi_plate: false }),
    ),
    http.get('/api/v1/library/files/:id/filament-requirements', () =>
      HttpResponse.json({
        filaments: [{ slot_id: 1, type: 'PETG', color: '#000000', used_grams: 109, used_meters: 36 }],
      }),
    ),
    http.post('/api/v1/queue/', async ({ request }) => {
      const body = (await request.json()) as Body;
      const response = reply(body, postCount++);
      if (response.status < 300) posted.push(body);
      return response;
    }),
  );
}

function renderGroup(
  props: Pick<ComponentProps<typeof PrintModal>, 'initialMultiFileMode' | 'initialSelectedPrinterIds'> = {},
  files: VariantCandidate[] = [BOTTOM_P1S, BOTTOM_H2S],
) {
  render(
    <PrintModal
      mode="create"
      libraryFileId={files[0].id}
      variantFiles={files}
      archiveName="bottom +1 more"
      onClose={() => {}}
      {...props}
    />,
  );
}

const printButton = () => screen.getByRole('button', { name: /^Print$/i });

describe('PrintModal: a version group on chosen printers (fork)', () => {
  beforeEach(() => {
    posted = [];
    postCount = 0;
    reply = () => HttpResponse.json({ id: postCount, status: 'pending' });
    window.sessionStorage.clear();
    mockBackend();
  });

  it('lists only the printers a version fits, without "any model"', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.click(await screen.findByRole('radio', { name: 'Chosen printers' }));

    expect(await screen.findByText('P1S One')).toBeInTheDocument();
    expect(screen.getByText('P1S Two')).toBeInTheDocument();
    expect(screen.getByText('H2S Big')).toBeInTheDocument();
    // A P1S slice may run on a P1P (#2578).
    expect(screen.getByText('P1P Old')).toBeInTheDocument();
    expect(screen.queryByText('A1 Mini')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Any /)).not.toBeInTheDocument();
    // Nothing chosen yet: every version is idle, and Print waits.
    expect(screen.getAllByText('No printer chosen')).toHaveLength(2);
    expect(printButton()).toBeDisabled();
  });

  it('queues the version for the chosen printer on that printer', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.click(await screen.findByRole('radio', { name: 'Chosen printers' }));
    await user.click(await screen.findByText('H2S Big'));

    expect(screen.getByText('Prints on: H2S Big')).toBeInTheDocument();
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ library_file_id: 22, printer_id: 3, target_model: null });
    expect(posted[0].variants).toBeUndefined();
  });

  it('gives each chosen printer the version for its model', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.click(await screen.findByRole('radio', { name: 'Chosen printers' }));
    await user.click(await screen.findByText('P1S Two'));
    await user.click(screen.getByText('H2S Big'));
    await user.click(screen.getByText('P1S One'));

    expect(screen.getByText(/^Prints on: P1S (Two|One), P1S (One|Two)$/)).toBeInTheDocument();
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(3));
    const pairs = posted.map((b) => [b.printer_id, b.library_file_id]).sort();
    expect(pairs).toEqual([
      [1, 21],
      [2, 21],
      [3, 22],
    ]);
  });

  it('warns when a printer gets a version sliced for a related model', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.click(await screen.findByRole('radio', { name: 'Chosen printers' }));
    await user.click(await screen.findByText('P1P Old'));

    expect(screen.getByText('Not sliced for P1P: bottom.gcode.3mf')).toBeInTheDocument();
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ library_file_id: 21, printer_id: 4 });
  });

  it('opens on chosen printers when asked to ("Print on…")', async () => {
    renderGroup({ initialMultiFileMode: 'printers' });
    expect(await screen.findByRole('radio', { name: 'Chosen printers' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Versions')).toBeInTheDocument();
  });

  it('prints the version for a printer chosen before opening, without the toggle', async () => {
    const user = userEvent.setup();
    renderGroup({ initialSelectedPrinterIds: [3] });

    expect(await screen.findByText('Prints on: H2S Big')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ library_file_id: 22, printer_id: 3 });
  });

  it('sends the OrcaSlicer import dialog’s decision id with every job (fork)', async () => {
    const user = userEvent.setup();
    render(
      <PrintModal
        mode="create"
        libraryFileId={BOTTOM_P1S.id}
        archiveName="bottom"
        slicerInboxClaim="tab:9"
        cleanupLibraryAfterDispatch
        onClose={() => {}}
      />,
    );
    await user.click(await screen.findByText('P1S One'));
    await user.click(screen.getByText('P1S Two'));
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((b) => b.slicer_inbox_claim)).toEqual(['tab:9', 'tab:9']);
  });

  it('counts one queue item per printer in the quantity hint, not one per version', async () => {
    renderGroup({ initialSelectedPrinterIds: [3] });
    fireEvent.change(await screen.findByLabelText('Quantity'), { target: { value: '2' } });
    expect(await screen.findByText('Creates 2 queue items')).toBeInTheDocument();
  });

  it('refuses a printer chosen before opening that no version fits', async () => {
    renderGroup({ initialSelectedPrinterIds: [5] });
    expect(await screen.findByText('No version of this group fits A1 Mini.')).toBeInTheDocument();
    expect(printButton()).toBeDisabled();
  });
});

describe('PrintModal: leaving a version out of the first-free job (fork)', () => {
  beforeEach(() => {
    posted = [];
    mockBackend();
  });

  it('queues the alternatives job without the unticked version', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.click(await screen.findByRole('checkbox', { name: 'Include bottom.gcode.3mf' }));
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0].variants as Body[]).map((v) => v.library_file_id)).toEqual([22]);
  });

  it('holds Print while every version is unticked', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.click(await screen.findByRole('checkbox', { name: 'Include bottom.gcode.3mf' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include H2S.bottom.gcode.3mf' }));
    expect(printButton()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Include H2S.bottom.gcode.3mf' }));
    await waitFor(() => expect(printButton()).toBeEnabled());
  });
});

describe('versionForModel (fork)', () => {
  const files: VariantCandidate[] = [
    { id: 1, filename: 'x1c', sliced_for_model: 'X1C' },
    { id: 2, filename: 'p1s', sliced_for_model: 'P1S' },
    { id: 3, filename: 'none', sliced_for_model: null },
    { id: 4, filename: 'h2d', sliced_for_model: 'H2D' },
  ];

  it('prefers the version sliced for the model, ignoring case, spaces and hyphens', () => {
    expect(versionForModel(files, 'p1s')?.id).toBe(2);
    expect(versionForModel(files, 'H2-D')?.id).toBe(4);
  });

  it('falls back to the first related model in list order', () => {
    expect(versionForModel(files, 'P1P')?.id).toBe(1);
  });

  it('never picks a version without a model, nor one for an unknown printer model', () => {
    expect(versionForModel(files, 'A1')).toBeNull();
    expect(versionForModel(files, null)).toBeNull();
  });
});

describe('queueSeparateJobs with a pair filter (fork)', () => {
  it('queues only the pairs the filter keeps, and counts only those', async () => {
    const created: Array<[number, number | null]> = [];
    const progress: Array<[number, number]> = [];
    const result = await queueSeparateJobs({
      files: [BOTTOM_P1S, BOTTOM_H2S],
      plateByFile: {},
      printerIds: [1, 3],
      includes: (file, printerId) => (file.id === 21 ? printerId === 1 : printerId === 3),
      quantity: 1,
      asap: false,
      buildItem: (file, _plate, printerId) => ({ library_file_id: file.id, printer_id: printerId }),
      addToQueue: async (data) => {
        created.push([data.library_file_id as number, data.printer_id ?? null]);
        return { id: created.length };
      },
      onProgress: (current, total) => progress.push([current, total]),
    });
    expect(created).toEqual([
      [21, 1],
      [22, 3],
    ]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(result.failure).toBeNull();
    expect(result.queuedFileIds).toEqual([21, 22]);
  });
});

// Fork: a version group on chosen printers that stops at a refusal. The
// printers that got their version stay chosen and are shown as done, never
// queued again, in this dialog or in the same group opened again.
describe('PrintModal: a version group run that stopped at a refusal (fork)', () => {
  beforeEach(() => {
    posted = [];
    postCount = 0;
    // The second POST (P1S Two) is refused, everything else goes in.
    reply = (_body, index) =>
      index === 1
        ? HttpResponse.json({ detail: 'Printer is in maintenance' }, { status: 400 })
        : HttpResponse.json({ id: index + 1, status: 'pending' });
    window.sessionStorage.clear();
    mockBackend();
  });

  async function runAndRefuse() {
    const user = userEvent.setup();
    await user.click(await screen.findByText('P1S One'));
    await user.click(screen.getByText('P1S Two'));
    await user.click(screen.getByText('H2S Big'));
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());
    await screen.findByTestId('run-report');
  }

  it('keeps what went in, what not and why on screen, and retries only the rest', async () => {
    renderGroup({ initialMultiFileMode: 'printers' });
    await runAndRefuse();
    const report = screen.getByTestId('run-report');
    expect(report).toHaveTextContent('In the queue (1):');
    expect(report).toHaveTextContent('bottom.gcode.3mf → P1S One');
    expect(report).toHaveTextContent('bottom.gcode.3mf → P1S Two: Printer is in maintenance');
    expect(report).toHaveTextContent('Not tried yet (1):');
    expect(report).toHaveTextContent('H2S.bottom.gcode.3mf → H2S Big');

    // The queued printer is done, not one that no version fits.
    expect(screen.queryByText(/No version of this group fits/)).not.toBeInTheDocument();
    expect(screen.getByText('Already in the queue on: P1S One')).toBeInTheDocument();
    expect(printButton()).toBeEnabled();

    reply = (_body, index) => HttpResponse.json({ id: index + 1, status: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry the rest' }));
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted.slice(1).map((b) => [b.printer_id, b.library_file_id])).toEqual([
      [2, 21],
      [3, 22],
    ]);
    // Complete: nothing is remembered for the next time.
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith('bambuddy.groupRun.'))).toEqual([]);
  });

  it('opened again, skips the printers that already have their version', async () => {
    const first = render(
      <PrintModal
        mode="create"
        libraryFileId={BOTTOM_P1S.id}
        variantFiles={[BOTTOM_P1S, BOTTOM_H2S]}
        archiveName="bottom +1 more"
        initialMultiFileMode="printers"
        onClose={() => {}}
      />,
    );
    await runAndRefuse();
    first.unmount();

    reply = (_body, index) => HttpResponse.json({ id: index + 1, status: 'pending' });
    renderGroup({ initialMultiFileMode: 'printers' });
    expect(await screen.findByTestId('group-run-resumed')).toHaveTextContent('Already queued on 1 printers');
    expect(await screen.findByText('Already in the queue on: P1S One')).toBeInTheDocument();
    const user = userEvent.setup();
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted.slice(1).map((b) => b.printer_id).sort()).toEqual([2, 3]);
  });

  it('one file on several printers: says who got it, and retries only the printer that refused', async () => {
    const user = userEvent.setup();
    render(<PrintModal mode="create" libraryFileId={BOTTOM_P1S.id} archiveName="bottom" onClose={() => {}} />);
    await user.click(await screen.findByText('P1S One'));
    await user.click(screen.getByText('P1S Two'));
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());

    const report = await screen.findByTestId('run-report');
    expect(report).toHaveTextContent('In the queue (1):');
    expect(report).toHaveTextContent('P1S One');
    expect(report).toHaveTextContent('P1S Two: Printer is in maintenance');

    reply = (_body, index) => HttpResponse.json({ id: index + 1, status: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry the rest' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((b) => b.printer_id)).toEqual([1, 2]);
  });

  it('can start over on purpose', async () => {
    renderGroup({ initialMultiFileMode: 'printers' });
    await runAndRefuse();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByText('Already in the queue on: P1S One')).not.toBeInTheDocument();
    expect(screen.getByText(/^Prints on: P1S One, P1S Two$/)).toBeInTheDocument();
  });
});
