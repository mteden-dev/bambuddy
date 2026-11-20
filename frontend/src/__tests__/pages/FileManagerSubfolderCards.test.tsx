/**
 * File Manager (fork): the open folder's subfolders are listed above its
 * files in the grid and list views, as SimplyPrint shows them, so a folder
 * that holds only subfolders no longer reads "Folder is empty". A click opens
 * the subfolder; a folder dropped on one moves into it; a search or tag
 * filter (whose results span every descendant) hides them.
 */

import { describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { FOLDER_DRAG_TYPE } from '../../utils/libraryFolders';

function folder(overrides: Record<string, unknown>) {
  return {
    parent_id: null,
    file_count: 0,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    is_external: false,
    external_path: null,
    external_readonly: false,
    latest_activity_at: null,
    created_by_id: 1,
    shared: false,
    can_write: true,
    can_rename: true,
    can_delete: true,
    children: [],
    ...overrides,
  };
}

// Snap (1)                 no files of its own
// ├── 223.100 (2)          6 files
// └── 223 Stack (3)
//     └── 9mm (5)
// Leaf (4)                 empty
// Mixed (6)                1 file
// └── Inner (7)
const folders = [
  folder({
    id: 1,
    name: 'Snap',
    children: [
      folder({ id: 2, name: '223.100', parent_id: 1, file_count: 6 }),
      folder({
        id: 3,
        name: '223 Stack',
        parent_id: 1,
        children: [folder({ id: 5, name: '9mm', parent_id: 3 })],
      }),
    ],
  }),
  folder({ id: 4, name: 'Leaf' }),
  folder({
    id: 6,
    name: 'Mixed',
    file_count: 1,
    children: [folder({ id: 7, name: 'Inner', parent_id: 6 })],
  }),
];

const mixedFile = {
  id: 11,
  filename: 'mixed.gcode.3mf',
  file_path: '/library/mixed.gcode.3mf',
  file_size: 1024,
  file_type: 'gcode.3mf',
  folder_id: 6,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: null,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2026-01-01T00:00:00Z',
};

describe('FileManager subfolders in the files area (fork)', () => {
  let listedFolderIds: (string | null)[] = [];
  let putBodies: { id: number; body: unknown }[] = [];

  beforeEach(() => {
    // localStorage is a vi.fn() stub in the test setup (grid view by default).
    (localStorage.getItem as Mock).mockReset();
    listedFolderIds = [];
    putBodies = [];
    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json(folders)),
      http.get('/api/v1/library/files', ({ request }) => {
        const folderId = new URL(request.url).searchParams.get('folder_id');
        listedFolderIds.push(folderId);
        return HttpResponse.json(folderId === '6' ? [mixedFile] : []);
      }),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({
          total_files: 1,
          total_folders: 7,
          total_size_bytes: 1024,
          disk_free_bytes: 10737418240,
          disk_total_bytes: 107374182400,
        }),
      ),
      http.put('/api/v1/library/folders/:id', async ({ request, params }) => {
        putBodies.push({ id: Number(params.id), body: await request.json() });
        return HttpResponse.json(folder({ id: Number(params.id), name: 'x', created_at: '', updated_at: '' }));
      }),
    );
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  function openAt(folderId: number) {
    window.history.pushState({}, '', `/files?folder=${folderId}`);
    return render(<FileManagerPage />);
  }

  function card(container: HTMLElement, id: number) {
    return container.querySelector<HTMLElement>(`[data-subfolder-id="${id}"]`)!;
  }

  it('shows the subfolders of a folder that has no files of its own instead of "Folder is empty"', async () => {
    const { container } = openAt(1);

    const grid = await screen.findByTestId('subfolder-grid');
    expect(within(grid).getByText('223.100')).toBeInTheDocument();
    expect(within(grid).getByText('223 Stack')).toBeInTheDocument();
    // Only direct children: the grandchild is not a card here.
    expect(within(grid).queryByText('9mm')).not.toBeInTheDocument();
    expect(screen.queryByText('Folder is empty')).not.toBeInTheDocument();

    // What each holds: files for one, a subfolder for the other.
    expect(within(card(container, 2)).getByTitle('Files: 6')).toBeInTheDocument();
    expect(within(card(container, 2)).queryByTestId('folder-card-folders')).not.toBeInTheDocument();
    expect(within(card(container, 3)).getByTitle('Subfolders: 1')).toBeInTheDocument();
    expect(within(card(container, 3)).queryByTestId('folder-card-files')).not.toBeInTheDocument();
  });

  it('opens a subfolder when its card is clicked', async () => {
    const { container } = openAt(1);
    await screen.findByTestId('subfolder-grid');

    const user = userEvent.setup();
    await user.click(within(card(container, 3)).getByRole('button', { name: /223 Stack/ }));

    await waitFor(() => expect(listedFolderIds).toContain('3'));
    const grid = await screen.findByTestId('subfolder-grid');
    await waitFor(() => expect(within(grid).getByText('9mm')).toBeInTheDocument());
    expect(within(grid).queryByText('223.100')).not.toBeInTheDocument();
  });

  it('lists the subfolders above the files', async () => {
    const { container } = openAt(6);

    const fileName = await screen.findByText('mixed.gcode.3mf');
    const innerCard = card(container, 7);
    expect(innerCard).toBeInTheDocument();
    expect(within(innerCard).getByText('Empty')).toBeInTheDocument();
    expect(innerCard.compareDocumentPosition(fileName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows subfolder rows before the file rows in the list view', async () => {
    (localStorage.getItem as Mock).mockImplementation((key: string) => (key === 'library-view-mode' ? 'list' : null));
    const { container } = openAt(6);

    await screen.findByText('mixed.gcode.3mf');
    const row = card(container, 7);
    expect(within(row).getByText('Inner')).toBeInTheDocument();
    expect(within(row).getByText('Folder')).toBeInTheDocument();
    const fileRow = screen.getByTestId('file-list-grid-row');
    expect(row.compareDocumentPosition(fileRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A click anywhere on the row opens the folder.
    fireEvent.click(row);
    await waitFor(() => expect(listedFolderIds).toContain('7'));
  });

  it('hides the subfolders while a search spans them', async () => {
    openAt(1);
    await screen.findByTestId('subfolder-grid');

    // The search box is offered even though the folder has no files of its own.
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Search files...'), 'nothing');

    await waitFor(() => expect(screen.queryByTestId('subfolder-grid')).not.toBeInTheDocument());
    expect(await screen.findByText('No matching files')).toBeInTheDocument();
    expect(screen.queryByText('Folder is empty')).not.toBeInTheDocument();
  });

  it('still calls a leaf folder without files empty', async () => {
    openAt(4);
    expect(await screen.findByText('Folder is empty')).toBeInTheDocument();
    expect(screen.queryByTestId('subfolder-grid')).not.toBeInTheDocument();
  });

  it('moves a folder dropped on a subfolder card into that subfolder', async () => {
    const { container } = openAt(1);
    await screen.findByTestId('subfolder-grid');

    // jsdom has no DataTransfer; this is the slice of it the handlers read.
    const data: Record<string, string> = {};
    const dataTransfer = {
      types: [] as string[],
      files: [] as File[],
      effectAllowed: 'uninitialized',
      dropEffect: 'none',
      setData(type: string, value: string) {
        data[type] = value;
        this.types = Object.keys(data);
      },
      getData(type: string) {
        return data[type] ?? '';
      },
    };
    fireEvent.dragStart(screen.getByText('Leaf').closest('div.group')!, { dataTransfer });
    expect(dataTransfer.getData(FOLDER_DRAG_TYPE)).toBe('4');

    const target = card(container, 2);
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => expect(putBodies).toEqual([{ id: 4, body: { parent_id: 2 } }]));
  });
});
