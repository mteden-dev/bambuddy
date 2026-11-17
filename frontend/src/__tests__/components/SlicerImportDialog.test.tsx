/**
 * Uploads from OrcaSlicer ask their uploader what to do (fork): print, add to
 * the queue in one click, save to the library or discard. A refused one-click
 * queue opens the print dialog on the queue choice instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SlicerImportDialog } from '../../components/SlicerImportDialog';
import { SLICER_UPLOAD_EVENT } from '../../utils/slicerInbox';

vi.mock('../../components/PrintModal', () => ({
  PrintModal: (props: {
    libraryFileId: number;
    preselectPlateId?: number | null;
    cleanupLibraryAfterDispatch?: boolean;
    initialScheduleOptions?: { scheduleType?: string; requireManualStart?: boolean };
    onClose: () => void;
    onSuccess?: () => void;
  }) => (
    <div data-testid="print-modal">
      <span>file:{props.libraryFileId}</span>
      <span>plate:{String(props.preselectPlateId ?? 'none')}</span>
      <span>cleanup:{String(!!props.cleanupLibraryAfterDispatch)}</span>
      <span>schedule:{props.initialScheduleOptions?.scheduleType ?? 'default'}</span>
      <span>manual:{String(!!props.initialScheduleOptions?.requireManualStart)}</span>
      <button onClick={props.onClose}>cancel-print</button>
      <button onClick={props.onSuccess}>print-done</button>
    </div>
  ),
}));

interface Upload {
  id: number;
  filename: string;
  folder_id: number | null;
  plate: number | null;
  print: boolean;
  sliced_for_model: string | null;
  print_time_seconds: number | null;
  filament_used_grams: number | null;
  created_at: string;
}

function upload(id: number, filename: string, over: Partial<Upload> = {}): Upload {
  return {
    id, filename, folder_id: 7, plate: 2, print: false, sliced_for_model: 'P1S',
    print_time_seconds: 3600, filament_used_grams: 12, created_at: '2026-11-17T08:00:00Z', ...over,
  };
}

function folder(id: number, name: string, children: unknown[] = [], over: Record<string, unknown> = {}) {
  return {
    id, name, parent_id: null, project_id: null, archive_id: null, project_name: null, archive_name: null,
    is_external: false, external_path: null, external_readonly: false, file_count: 0, latest_activity_at: null,
    created_by_id: 1, shared: true, can_write: true, can_rename: true, can_delete: true, children, ...over,
  };
}

let pending: Upload[] = [];
let manualStart = false;
let queueReply: () => Response = () => HttpResponse.json({ id: 1 });
const queued: Record<string, unknown>[] = [];
const moves: { file_ids: number[]; folder_id: number | null }[] = [];
const renames: { id: number; filename: string }[] = [];
const deletes: number[] = [];

const drop = (id: number) => {
  pending = pending.filter((u) => u.id !== id);
};

beforeEach(() => {
  pending = [upload(10, 'Cube.gcode.3mf', { print: true }), upload(11, 'Clip.gcode.3mf', { plate: null })];
  manualStart = false;
  queueReply = () => HttpResponse.json({ id: 1 });
  queued.length = 0;
  moves.length = 0;
  renames.length = 0;
  deletes.length = 0;
  vi.mocked(localStorage.setItem).mockClear();
  server.use(
    http.get('/api/v1/slicer-inbox/pending', () => HttpResponse.json(pending)),
    http.get('/api/v1/settings/ui-flags', () => HttpResponse.json({ slicer_inbox_manual_start: manualStart })),
    http.get('/api/v1/library/files/:id/plates', ({ params }) =>
      HttpResponse.json({
        file_id: Number(params.id),
        filename: 'x',
        is_multi_plate: false,
        plates: [
          {
            index: 2, name: null, objects: [], has_thumbnail: false, thumbnail_url: null,
            print_time_seconds: 5400, filament_used_grams: 30,
            filaments: [{ slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 30, used_meters: 10 }],
          },
        ],
      }),
    ),
    http.get('/api/v1/library/folders', () =>
      HttpResponse.json([folder(7, 'OrcaSlicer'), folder(8, 'Holders', [folder(9, 'Small', [], { parent_id: 8 })])]),
    ),
    http.post('/api/v1/queue/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      queued.push(body);
      const reply = queueReply();
      if (reply.status < 300) drop(body.library_file_id as number);
      return reply;
    }),
    http.post('/api/v1/library/files/move', async ({ request }) => {
      const body = (await request.json()) as { file_ids: number[]; folder_id: number | null };
      moves.push(body);
      body.file_ids.forEach(drop);
      return HttpResponse.json({ status: 'success', moved: body.file_ids.length, skipped: 0, skipped_reasons: [] });
    }),
    http.put('/api/v1/library/files/:id', async ({ params, request }) => {
      const body = (await request.json()) as { filename: string };
      renames.push({ id: Number(params.id), filename: body.filename });
      return HttpResponse.json({ id: Number(params.id), filename: body.filename });
    }),
    http.delete('/api/v1/library/files/:id', ({ params }) => {
      deletes.push(Number(params.id));
      drop(Number(params.id));
      return HttpResponse.json({ status: 'success', message: 'File moved to trash', trashed: true });
    }),
  );
});

describe('SlicerImportDialog', () => {
  it('asks about the oldest upload first, with its plate', async () => {
    render(<SlicerImportDialog />);
    expect(await screen.findByText('Cube.gcode.3mf')).toBeInTheDocument();
    expect(screen.getByText('New file from OrcaSlicer')).toBeInTheDocument();
    expect(screen.getByText('File 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Sliced for P1S')).toBeInTheDocument();
    expect(screen.getByText('Plate 2')).toBeInTheDocument();
    expect(screen.getByText('Sent with “Upload and print”')).toBeInTheDocument();
    expect(await screen.findByText('PLA')).toBeInTheDocument();
    for (const label of ['Print', 'Add to queue', 'Save to files', 'Discard']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeEnabled();
    }
  });

  it('shows nothing when no upload is waiting', async () => {
    pending = [];
    render(<SlicerImportDialog />);
    await waitFor(() => expect(screen.queryByText('New file from OrcaSlicer')).not.toBeInTheDocument());
  });

  it('Print opens the print dialog on the sliced plate, and comes back when cancelled', async () => {
    render(<SlicerImportDialog />);
    fireEvent.click(await screen.findByRole('button', { name: /^Print/ }));
    const modal = await screen.findByTestId('print-modal');
    expect(modal).toHaveTextContent('file:10');
    expect(modal).toHaveTextContent('plate:2');
    expect(modal).toHaveTextContent('cleanup:true');
    expect(modal).toHaveTextContent('schedule:default');

    fireEvent.click(screen.getByText('cancel-print'));
    expect(await screen.findByText('Cube.gcode.3mf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Print/ }));
    drop(10);
    fireEvent.click(await screen.findByText('print-done'));
    expect(await screen.findByText('Clip.gcode.3mf')).toBeInTheDocument();
  });

  it('Add to queue queues any printer of the model in one click', async () => {
    manualStart = true;
    render(<SlicerImportDialog />);
    // The plates load after ui-flags, which carries the manual-start setting.
    await screen.findByText('PLA');
    fireEvent.click(screen.getByRole('button', { name: /^Add to queue/ }));
    await waitFor(() => expect(queued).toHaveLength(1));
    expect(queued[0]).toEqual({
      library_file_id: 10,
      target_model: 'P1S',
      plate_id: 2,
      cleanup_library_after_dispatch: true,
      manual_start: true,
    });
    expect(await screen.findByText('Clip.gcode.3mf')).toBeInTheDocument();
    expect(screen.queryByTestId('print-modal')).not.toBeInTheDocument();
  });

  it('a refused one-click queue opens the print dialog on the queue choice', async () => {
    queueReply = () => HttpResponse.json({ detail: 'No active printers for model: P1S' }, { status: 400 });
    render(<SlicerImportDialog />);
    fireEvent.click(await screen.findByRole('button', { name: /^Add to queue/ }));
    const modal = await screen.findByTestId('print-modal');
    expect(modal).toHaveTextContent('file:10');
    expect(modal).toHaveTextContent('schedule:queue');
    expect(await screen.findByText(/No active printers for model: P1S/)).toBeInTheDocument();
  });

  it('a file naming no printer model goes straight to the print dialog', async () => {
    pending = [upload(12, 'Generic.gcode.3mf', { sliced_for_model: null })];
    render(<SlicerImportDialog />);
    expect(await screen.findByText('Choose the printer in the print dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Add to queue/ }));
    const modal = await screen.findByTestId('print-modal');
    expect(modal).toHaveTextContent('schedule:queue');
    expect(queued).toHaveLength(0);
  });

  it('Save to files renames and moves it, never back into the inbox', async () => {
    render(<SlicerImportDialog />);
    fireEvent.click(await screen.findByRole('button', { name: /^Save to files/ }));
    const select = await screen.findByLabelText('Folder');
    await waitFor(() => expect(screen.getByRole('option', { name: /Small/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'OrcaSlicer' })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'Cube v2.gcode.3mf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(moves).toEqual([{ file_ids: [10], folder_id: 9 }]));
    expect(renames).toEqual([{ id: 10, filename: 'Cube v2.gcode.3mf' }]);
    expect(await screen.findByText('Clip.gcode.3mf')).toBeInTheDocument();
    expect(localStorage.setItem).toHaveBeenCalledWith('slicerInbox.lastFolder', '9');
  });

  it('Discard moves it to the trash', async () => {
    render(<SlicerImportDialog />);
    fireEvent.click(await screen.findByRole('button', { name: /^Discard/ }));
    await waitFor(() => expect(deletes).toEqual([10]));
    expect(await screen.findByText('Clip.gcode.3mf')).toBeInTheDocument();
  });

  it('closing puts the file off, and a new upload is asked about at once', async () => {
    pending = [upload(10, 'Cube.gcode.3mf')];
    render(<SlicerImportDialog />);
    await screen.findByText('Cube.gcode.3mf');
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    await waitFor(() => expect(screen.queryByText('Cube.gcode.3mf')).not.toBeInTheDocument());

    pending = [upload(10, 'Cube.gcode.3mf'), upload(20, 'Fresh.gcode.3mf')];
    act(() => {
      window.dispatchEvent(new CustomEvent(SLICER_UPLOAD_EVENT, { detail: { file_id: 20 } }));
    });
    expect(await screen.findByText('Fresh.gcode.3mf')).toBeInTheDocument();
    expect(screen.queryByText('Cube.gcode.3mf')).not.toBeInTheDocument();
  });
});
