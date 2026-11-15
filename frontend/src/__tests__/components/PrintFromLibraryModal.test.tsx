/**
 * The printer card's Print button opens a library picker (fork): choose a
 * sliced file from your files, or upload one into the open folder, then the
 * print dialog opens for this printer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintFromLibraryModal } from '../../components/PrintFromLibraryModal';

vi.mock('../../components/PrintModal', () => ({
  PrintModal: (props: { libraryFileId: number; initialSelectedPrinterIds: number[]; onClose: () => void }) => (
    <div data-testid="print-modal">
      <span>file:{props.libraryFileId}</span>
      <span>printers:{props.initialSelectedPrinterIds.join(',')}</span>
      <button onClick={props.onClose}>cancel-print</button>
    </div>
  ),
}));

function folder(id: number, name: string, children: unknown[] = [], over: Record<string, unknown> = {}) {
  return {
    id, name, parent_id: null, project_id: null, archive_id: null, project_name: null, archive_name: null,
    is_external: false, external_path: null, external_readonly: false, file_count: 0, latest_activity_at: null,
    created_by_id: 1, shared: false, can_write: true, can_rename: true, can_delete: true, children, ...over,
  };
}

function file(id: number, filename: string, folderId: number | null, over: Record<string, unknown> = {}) {
  return {
    id, folder_id: folderId, is_external: false, filename,
    file_type: filename.endsWith('.gcode.3mf') ? 'gcode.3mf' : filename.split('.').pop(),
    file_size: 1000, thumbnail_path: null, print_count: 0, duplicate_count: 0, created_by_id: 1,
    created_by_username: 'me', created_at: '2026-01-01T00:00:00Z', fs_modified_at: null, print_name: null,
    print_time_seconds: 3600, filament_used_grams: 12, sliced_for_model: 'X1C', tags: [], ...over,
  };
}

const folders = [
  folder(1, 'Holders', [folder(3, 'Small', [], { parent_id: 1 })]),
  folder(2, 'Sources only'),
];
const files = [
  file(10, 'Root part.gcode.3mf', null),
  file(11, 'Model.stl', null, { file_type: 'stl', sliced_for_model: null }),
  file(12, 'Clip.gcode.3mf', 3),
  file(13, 'Raw.3mf', 2, { file_type: '3mf', sliced_for_model: null }),
  file(14, 'Other printer.gcode.3mf', null, { sliced_for_model: 'A1' }),
];

const uploads: number[] = [];
const deletes: number[] = [];

beforeEach(() => {
  uploads.length = 0;
  deletes.length = 0;
  server.use(
    http.get('/api/v1/library/folders', () => HttpResponse.json(folders)),
    http.get('/api/v1/library/files', () => HttpResponse.json(files)),
  );
});

function renderPicker(onClose = vi.fn()) {
  render(<PrintFromLibraryModal printerId={5} printerName="002" printerModel="BL-P001" onClose={onClose} />);
  return onClose;
}

describe('PrintFromLibraryModal', () => {
  it('lists sliced files and folders that hold one, nothing else', async () => {
    renderPicker();
    expect(await screen.findByText('Root part.gcode.3mf')).toBeInTheDocument();
    expect(screen.getByText('Print on 002')).toBeInTheDocument();
    expect(screen.getByText('Holders')).toBeInTheDocument();
    expect(screen.getByText('Files to print: 1')).toBeInTheDocument();
    // Source files and a folder with nothing printable are left out.
    expect(screen.queryByText('Model.stl')).not.toBeInTheDocument();
    expect(screen.queryByText('Sources only')).not.toBeInTheDocument();
  });

  it('hides files sliced for another model until asked, then shows them disabled', async () => {
    renderPicker();
    await screen.findByText('Root part.gcode.3mf');
    expect(screen.queryByText('Other printer.gcode.3mf')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show files for other printers (1)'));
    const row = (await screen.findByText('Other printer.gcode.3mf')).closest('button')!;
    expect(row).toBeDisabled();
  });

  it('walks into folders and back through the breadcrumb', async () => {
    renderPicker();
    fireEvent.click(await screen.findByText('Holders'));
    fireEvent.click(await screen.findByText('Small'));
    expect(await screen.findByText('Clip.gcode.3mf')).toBeInTheDocument();
    expect(screen.queryByText('Root part.gcode.3mf')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Location' });
    fireEvent.click(within(nav).getByText('Library'));
    expect(await screen.findByText('Root part.gcode.3mf')).toBeInTheDocument();
  });

  it('searches the whole library, not just the open folder', async () => {
    renderPicker();
    await screen.findByText('Root part.gcode.3mf');
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'clip' } });
    expect(await screen.findByText('Clip.gcode.3mf')).toBeInTheDocument();
    expect(screen.queryByText('Root part.gcode.3mf')).not.toBeInTheDocument();
    expect(screen.queryByText('Holders')).not.toBeInTheDocument();
  });

  it('opens the print dialog for this printer, and cancelling returns to the picker', async () => {
    renderPicker();
    fireEvent.click(await screen.findByText('Root part.gcode.3mf'));
    const modal = await screen.findByTestId('print-modal');
    expect(within(modal).getByText('file:10')).toBeInTheDocument();
    expect(within(modal).getByText('printers:5')).toBeInTheDocument();
    fireEvent.click(within(modal).getByText('cancel-print'));
    await waitFor(() => expect(screen.queryByTestId('print-modal')).not.toBeInTheDocument());
    expect(screen.getByText('Root part.gcode.3mf')).toBeVisible();
  });

  it('uploads a sliced file and goes straight to the print dialog', async () => {
    server.use(
      http.post('/api/v1/library/files', () => {
        uploads.push(1);
        return HttpResponse.json({
          id: 99, filename: 'new.gcode.3mf', file_type: 'gcode.3mf', file_size: 10, thumbnail_path: null,
          duplicate_of: null, metadata: { sliced_for_model: 'X1C' },
        });
      }),
    );
    renderPicker();
    await screen.findByText('Root part.gcode.3mf');
    fireEvent.change(screen.getByTestId('print-picker-file-input'), {
      target: { files: [new File(['x'], 'new.gcode.3mf')] },
    });
    const modal = await screen.findByTestId('print-modal');
    expect(within(modal).getByText('file:99')).toBeInTheDocument();
    expect(uploads).toHaveLength(1);
  });

  it('removes an upload sliced for another printer and says why', async () => {
    server.use(
      http.post('/api/v1/library/files', () =>
        HttpResponse.json({
          id: 98, filename: 'a1.gcode.3mf', file_type: 'gcode.3mf', file_size: 10, thumbnail_path: null,
          duplicate_of: null, metadata: { sliced_for_model: 'A1' },
        }),
      ),
      http.delete('/api/v1/library/files/:id', ({ params }) => {
        deletes.push(Number(params.id));
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    renderPicker();
    await screen.findByText('Root part.gcode.3mf');
    fireEvent.change(screen.getByTestId('print-picker-file-input'), {
      target: { files: [new File(['x'], 'a1.gcode.3mf')] },
    });
    expect(await screen.findByText(/sliced for A1/)).toBeInTheDocument();
    expect(deletes).toEqual([98]);
    expect(screen.queryByTestId('print-modal')).not.toBeInTheDocument();
  });

  it('rejects a file that cannot be sliced before uploading it', async () => {
    renderPicker();
    await screen.findByText('Root part.gcode.3mf');
    fireEvent.change(screen.getByTestId('print-picker-file-input'), {
      target: { files: [new File(['x'], 'model.stl')] },
    });
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('.text-red-300')).not.toBeNull());
    expect(uploads).toHaveLength(0);
  });
});
