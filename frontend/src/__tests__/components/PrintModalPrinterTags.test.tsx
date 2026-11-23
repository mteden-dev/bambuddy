/**
 * Fork: printer tags in the print dialog.
 *
 * A file with a tag some printer carries opens on "Any <model>" with that tag,
 * and the job is sent without tags so the queue reads the file's. Changing the
 * tags in the dialog sends them with the job.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintModal } from '../../components/PrintModal';
import { printerAcceptsTags } from '../../utils/printerTags';

const PRINTERS = [
  { id: 1, name: 'P1S One', model: 'P1S', ip_address: '192.0.2.1', is_active: true, enabled: true },
  { id: 2, name: 'P1S Tray', model: 'P1S', ip_address: '192.0.2.2', is_active: true, enabled: true },
];
const TAGS = [
  { id: 7, name: 'tray', file_count: 1, created_at: '', updated_at: '' },
  { id: 8, name: 'left', file_count: 0, created_at: '', updated_at: '' },
];

type Body = Record<string, unknown>;
let posted: Body[];

function mockBackend(fileTags: number[]) {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(PRINTERS)),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] }),
    ),
    http.get('/api/v1/printers/available-filaments', () => HttpResponse.json([])),
    http.get('/api/v1/library/files/:id', () =>
      HttpResponse.json({ id: 5, filename: 'tray.gcode.3mf', file_type: 'gcode.3mf', sliced_for_model: 'P1S' }),
    ),
    http.get('/api/v1/library/files/:id/plates', () =>
      HttpResponse.json({ file_id: 5, filename: 'x', plates: [], is_multi_plate: false }),
    ),
    http.get('/api/v1/library/files/:id/filament-requirements', () => HttpResponse.json({ filaments: [] })),
    http.get('/api/v1/library/tags', () => HttpResponse.json(TAGS)),
    http.get('/api/v1/printer-tags', () =>
      HttpResponse.json([
        { printer_id: 2, tag_ids: [7], exclusive: true },
        { printer_id: 1, tag_ids: [8], exclusive: false },
      ]),
    ),
    http.get('/api/v1/printer-tags/files', () =>
      HttpResponse.json(fileTags.length ? [{ file_id: 5, tag_ids: fileTags }] : []),
    ),
    http.post('/api/v1/queue/', async ({ request }) => {
      posted.push((await request.json()) as Body);
      return HttpResponse.json({ id: posted.length, status: 'pending' });
    }),
  );
}

function renderDialog() {
  render(<PrintModal mode="create" libraryFileId={5} archiveName="tray" onClose={() => {}} />);
}

describe('PrintModal: printer tags (fork)', () => {
  beforeEach(() => {
    posted = [];
  });

  it("opens a tagged file on 'Any P1S' with the file's tag and sends no tags of its own", async () => {
    mockBackend([7]);
    const user = userEvent.setup();
    renderDialog();

    const row = await screen.findByTestId('job-printer-tags');
    expect(within(row).getByText('tray')).toBeInTheDocument();
    expect(within(row).getByText(/from the file/)).toBeInTheDocument();
    expect(await screen.findByText('Only P1S printers with: tray')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add to queue|^print$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].target_model).toBe('P1S');
    expect(posted[0]).not.toHaveProperty('required_tag_ids');
  });

  it('sends the tags chosen in the dialog with the job', async () => {
    mockBackend([7]);
    const user = userEvent.setup();
    renderDialog();

    const row = await screen.findByTestId('job-printer-tags');
    await user.click(within(row).getByRole('button', { name: 'Remove tray' }));
    await user.click(within(row).getByRole('button', { name: 'Add tag' }));
    await user.click(await within(row).findByRole('button', { name: 'left' }));
    expect(within(row).getByText(/set for this job/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add to queue|^print$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].required_tag_ids).toEqual([8]);
  });

  it('warns when no printer of the model has the tags', async () => {
    mockBackend([7]);
    const user = userEvent.setup();
    renderDialog();

    const row = await screen.findByTestId('job-printer-tags');
    await user.click(within(row).getByRole('button', { name: 'Add tag' }));
    await user.click(await within(row).findByRole('button', { name: 'left' }));

    expect(await screen.findByText(/No active P1S printer has these tags/)).toBeInTheDocument();
  });

  it('leaves an untagged file on a specific printer, as before', async () => {
    mockBackend([]);
    renderDialog();

    expect(await screen.findByText('P1S One')).toBeInTheDocument();
    expect(screen.queryByTestId('job-printer-tags')).not.toBeInTheDocument();
  });
});

describe('printerAcceptsTags', () => {
  it('needs every tag, and an exclusive printer one of its own', () => {
    expect(printerAcceptsTags(undefined, [])).toBe(true);
    expect(printerAcceptsTags(undefined, [7])).toBe(false);
    expect(printerAcceptsTags({ printer_id: 1, tag_ids: [7, 8], exclusive: false }, [7])).toBe(true);
    expect(printerAcceptsTags({ printer_id: 1, tag_ids: [7], exclusive: false }, [])).toBe(true);
    expect(printerAcceptsTags({ printer_id: 1, tag_ids: [7], exclusive: true }, [])).toBe(false);
    expect(printerAcceptsTags({ printer_id: 1, tag_ids: [7], exclusive: true }, [7])).toBe(true);
  });
});
