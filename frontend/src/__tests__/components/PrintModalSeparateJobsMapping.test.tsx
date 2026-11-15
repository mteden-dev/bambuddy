/**
 * Separate jobs on one printer get a filament mapping panel per file.
 *
 * Several sliced files queued as separate jobs used to carry no mapping at all,
 * and the scheduler picked each file's trays at dispatch without asking. With
 * one printer selected each file now has its own panel. A file changed there
 * carries that mapping; a file left alone still leaves its trays to the
 * scheduler, so jobs that start hours later see the spools loaded by then.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintModal } from '../../components/PrintModal';
import type { VariantCandidate } from '../../components/PrintModal/VariantCandidates';
import type { SeparateJobsResume } from '../../components/PrintModal/separateJobs';
import { perFileMappingKey } from '../../components/PrintModal/perFileMapping';

const PART_A: VariantCandidate = { id: 11, filename: 'part-a.gcode.3mf', sliced_for_model: 'A1' };
const PART_B: VariantCandidate = { id: 12, filename: 'part-b.gcode.3mf', sliced_for_model: 'A1' };
const BY_ID: Record<number, VariantCandidate> = { 11: PART_A, 12: PART_B };

// Part A asks for white PLA, which is loaded. Part B asks for black PLA, which
// is not: the panel falls back to a PLA of another colour.
const REQS: Record<number, { slot_id: number; type: string; color: string }[]> = {
  11: [{ slot_id: 1, type: 'PLA', color: '#FFFFFF' }],
  12: [{ slot_id: 1, type: 'PLA', color: '#000000' }],
};

type Body = Record<string, unknown>;
let posted: Body[];
let respond: (body: Body, index: number) => Response;

function mockBackend() {
  server.use(
    http.get('/api/v1/printers/', () =>
      HttpResponse.json([
        { id: 1, name: 'A1 Test', model: 'A1', ip_address: '192.0.2.1', is_active: true, enabled: true },
        { id: 3, name: 'A1 Second', model: 'A1', ip_address: '192.0.2.3', is_active: true, enabled: true },
      ]),
    ),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({
        connected: true,
        state: 'IDLE',
        ams: [
          {
            id: 0,
            tray: [
              { id: 0, tray_type: 'PLA', tray_color: 'FFFFFFFF', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic' },
              { id: 1, tray_type: 'PLA', tray_color: 'FF0000FF', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Matte' },
              { id: 2, tray_type: 'PETG', tray_color: '0000FFFF', tray_info_idx: 'GFG02', tray_sub_brands: 'PETG HF' },
            ],
          },
        ],
        vt_tray: [],
      }),
    ),
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
    http.get('/api/v1/library/files/:id/filament-requirements', ({ params }) =>
      HttpResponse.json({
        filaments: REQS[Number(params.id)].map((f) => ({ ...f, used_grams: 15, used_meters: 5 })),
      }),
    ),
    http.post('/api/v1/queue/', async ({ request }) => {
      const body = (await request.json()) as Body;
      posted.push(body);
      return respond(body, posted.length - 1);
    }),
  );
}

function renderModal(
  extra: { onSeparateJobsProgress?: (p: unknown) => void; resumeSeparateJobs?: SeparateJobsResume } = {},
) {
  render(
    <PrintModal
      mode="create"
      libraryFileId={PART_A.id}
      variantFiles={[PART_A, PART_B]}
      archiveName="parts"
      separateJobsAllowed
      onClose={() => {}}
      {...extra}
    />,
  );
}

const printButton = () => screen.getByRole('button', { name: /^Print$/i });
const panelHeader = (file: VariantCandidate) =>
  screen.findByRole('button', { name: new RegExp(`Filament Mapping — ${file.filename.replace(/\./g, '\\.')}`) });

async function pickPrinterAndWait(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByText(name));
  await waitFor(() => expect(printButton()).toBeEnabled());
}

/** Expands the file's panel and picks the slot whose label matches `slot`. */
async function pickSlot(user: ReturnType<typeof userEvent.setup>, file: VariantCandidate, slot: RegExp) {
  await user.click(await panelHeader(file));
  const trigger = await waitFor(() => screen.getByRole('combobox', { name: /Printer slot for/ }));
  fireEvent.click(trigger);
  const listbox = await waitFor(() => screen.getByRole('listbox'));
  fireEvent.click(within(listbox).getByRole('option', { name: slot }));
}

describe('PrintModal: separate jobs on one printer, a mapping panel per file', () => {
  beforeEach(() => {
    posted = [];
    respond = (_body, index) => HttpResponse.json({ id: index + 1, status: 'pending' });
    mockBackend();
  });

  it('shows one panel per file, with its own match status', async () => {
    const user = userEvent.setup();
    renderModal();

    await pickPrinterAndWait(user, 'A1 Test');

    expect(await panelHeader(PART_A)).toHaveTextContent('Ready');
    expect(await panelHeader(PART_B)).toHaveTextContent('Color mismatch');
    expect(screen.getByText(/Each file has its own filament mapping/)).toBeInTheDocument();
  });

  it('sends no mapping for files left as they are', async () => {
    const user = userEvent.setup();
    renderModal();

    await pickPrinterAndWait(user, 'A1 Test');
    await panelHeader(PART_B);
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(2));
    for (const body of posted) {
      expect(body.ams_mapping).toBeUndefined();
      expect(body).not.toHaveProperty('skip_filament_check');
    }
  });

  it('sends the mapping of a file changed in its panel, and only for that file', async () => {
    const user = userEvent.setup();
    renderModal();

    await pickPrinterAndWait(user, 'A1 Test');
    await pickSlot(user, PART_B, /PLA Matte/);
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((b) => b.library_file_id)).toEqual([11, 12]);
    expect(posted[0].ams_mapping).toBeUndefined();
    expect(posted[1].ams_mapping).toEqual([1]);
    // Same material, another colour: nothing for the scheduler to overrule.
    expect(posted[1]).not.toHaveProperty('skip_filament_check');
  });

  it('marks a pick of another material as the user’s choice (#2799)', async () => {
    const user = userEvent.setup();
    renderModal();

    await pickPrinterAndWait(user, 'A1 Test');
    await pickSlot(user, PART_B, /PETG HF/);
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].ams_mapping).toEqual([2]);
    expect(posted[1].skip_filament_check).toBe(true);
  });

  it('shows no per-file panels with two printers selected', async () => {
    const user = userEvent.setup();
    renderModal();

    await pickPrinterAndWait(user, 'A1 Test');
    await panelHeader(PART_A);
    await user.click(screen.getByText('A1 Second'));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Filament Mapping — / })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Each file has its own filament mapping/)).not.toBeInTheDocument();
  });

  it('keeps the picks for the rest of a refused run', async () => {
    respond = (_body, index) =>
      index === 0
        ? HttpResponse.json({ detail: 'refused' }, { status: 400 })
        : HttpResponse.json({ id: index + 1, status: 'pending' });
    const onSeparateJobsProgress = vi.fn();
    const user = userEvent.setup();
    renderModal({ onSeparateJobsProgress });

    await pickPrinterAndWait(user, 'A1 Test');
    await pickSlot(user, PART_B, /PLA Matte/);
    await user.click(printButton());
    await screen.findByText(/Not queued: part-a\.gcode\.3mf/);

    // Nothing went in, so there is no run to resume; the dialog itself keeps
    // the picks for the resubmit.
    expect(onSeparateJobsProgress).not.toHaveBeenCalled();
    respond = (_body, index) => HttpResponse.json({ id: index + 1, status: 'pending' });
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2].library_file_id).toBe(12);
    expect(posted[2].ams_mapping).toEqual([1]);
  });

  it('reports the picks with a partly queued run and starts from them when reopened', async () => {
    respond = (_body, index) =>
      index === 1
        ? HttpResponse.json({ detail: 'refused' }, { status: 400 })
        : HttpResponse.json({ id: index + 1, status: 'pending' });
    const onSeparateJobsProgress = vi.fn();
    const user = userEvent.setup();
    renderModal({ onSeparateJobsProgress });

    await pickPrinterAndWait(user, 'A1 Test');
    await pickSlot(user, PART_B, /PLA Matte/);
    await user.click(printButton());
    await screen.findByText(/Not queued: part-b\.gcode\.3mf/);

    const key = perFileMappingKey(1, PART_B.id, null);
    expect(onSeparateJobsProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ manualMappingsByFile: expect.objectContaining({ [key]: { 1: 1 } }) }),
      }),
    );
  });
});

describe('PrintModal: a reopened separate-jobs run', () => {
  beforeEach(() => {
    posted = [];
    respond = (_body, index) => HttpResponse.json({ id: index + 10, status: 'pending' });
    mockBackend();
  });

  it('queues the rest with the picks it was submitted with', async () => {
    const user = userEvent.setup();
    render(
      <PrintModal
        mode="create"
        libraryFileId={PART_B.id}
        variantFiles={[PART_B]}
        archiveName="parts"
        separateJobsAllowed
        resumeSeparateJobs={{
          queuedPairs: ['11:1'],
          asapInserted: 0,
          settings: {
            plateByFile: {},
            assignmentMode: 'printer',
            printerIds: [1],
            targetModel: null,
            targetLocation: null,
            quantity: 1,
            printOptions: (await import('../../components/PrintModal/types')).DEFAULT_PRINT_OPTIONS,
            scheduleOptions: (await import('../../components/PrintModal/types')).DEFAULT_SCHEDULE_OPTIONS,
            costCenterId: null,
            manualMappingsByFile: { [perFileMappingKey(1, PART_B.id, null)]: { 1: 1 } },
          },
        }}
        onClose={() => {}}
      />,
    );

    await panelHeader(PART_B);
    await waitFor(() => expect(printButton()).toBeEnabled());
    await user.click(printButton());

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].library_file_id).toBe(12);
    expect(posted[0].ams_mapping).toEqual([1]);
  });
});
