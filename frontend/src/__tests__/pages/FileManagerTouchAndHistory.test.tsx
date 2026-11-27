/**
 * File Manager on a phone and an iPad (fork): the open folder is a history
 * step, a version group can grow and take a removal back, the selection
 * forgets files that are gone, and a touch device gets its own controls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { focusManager } from '@tanstack/react-query';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { LAST_FOLDER_KEY } from '../../pages/fileManager/useFolderInUrl';

vi.mock('../../components/ModelViewerModal', () => ({
  ModelViewerModal: () => <div />,
}));

type Item = Record<string, unknown>;

function item(id: number, filename: string, over: Item = {}): Item {
  return {
    id,
    folder_id: null,
    is_external: false,
    filename,
    file_type: 'gcode.3mf',
    file_size: 1048576,
    thumbnail_path: null,
    print_count: 0,
    duplicate_count: 0,
    created_by_id: null,
    created_by_username: null,
    created_at: '2024-01-01T00:00:00Z',
    fs_modified_at: null,
    print_name: null,
    print_time_seconds: null,
    filament_used_grams: null,
    sliced_for_model: null,
    tags: [],
    variant_group_id: null,
    variant_count: 0,
    variant_group_name: null,
    variant_position: null,
    variant_elsewhere: false,
    folder_name: null,
    ...over,
  };
}

const vase = (id: number, model: string, position: number, count: number) =>
  item(id, `vase_${model}.gcode.3mf`, {
    variant_group_id: 7,
    variant_count: count,
    variant_group_name: 'Vase',
    variant_position: position,
    sliced_for_model: model,
  });

function folder(over: Record<string, unknown>) {
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
    ...over,
  };
}

// Parts (1) with Boxes (2) inside it.
const folders = [folder({ id: 1, name: 'Parts', children: [folder({ id: 2, name: 'Boxes', parent_id: 1 })] })];

let files: Item[] = [];

function serve() {
  server.use(
    http.get('/api/v1/library/folders', () => HttpResponse.json(folders)),
    http.get('/api/v1/library/files', () => HttpResponse.json(files)),
    http.get('/api/v1/library/stats', () =>
      HttpResponse.json({ total_files: 1, total_folders: 2, total_size_bytes: 1, disk_free_bytes: 1e12, disk_total_bytes: 1e13 }),
    ),
    http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false, library_disk_warning_gb: 5 })),
    http.get('/api/v1/projects/', () => HttpResponse.json([])),
    http.get('/api/v1/archives/', () => HttpResponse.json([])),
  );
}

const originalMatchMedia = window.matchMedia;
const originalWidth = window.innerWidth;

// A touch device: `(any-pointer: coarse)` matches.
function touchDevice() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({ ...originalMatchMedia(query), matches: query.includes('pointer: coarse') }),
  });
}

function width(px: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: px });
}

describe('File Manager on touch devices and with history (fork)', () => {
  beforeEach(() => {
    localStorage.clear();
    files = [item(30, 'plain.gcode.3mf', { folder_id: null, sliced_for_model: 'X1C' })];
    serve();
  });
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
    width(originalWidth);
  });

  describe('the open folder lives in the URL', () => {
    it('pushes ?folder= when a subfolder opens, and Back goes up again', async () => {
      window.history.replaceState(null, '', '/files?folder=1');
      const user = userEvent.setup();
      const { container } = render(<FileManagerPage />);
      await screen.findByTestId('subfolder-grid');

      const before = window.history.length;
      await user.click(within(container.querySelector<HTMLElement>('[data-subfolder-id="2"]')!).getByRole('button', { name: /Boxes/ }));
      await waitFor(() => expect(new URLSearchParams(window.location.search).get('folder')).toBe('2'));
      expect(window.history.length).toBe(before + 1);

      act(() => window.history.back());
      await waitFor(() => expect(new URLSearchParams(window.location.search).get('folder')).toBe('1'));
      // The page follows: Parts again, with Boxes as its card.
      expect(await screen.findByTestId('subfolder-grid')).toBeInTheDocument();
      expect(container.querySelector('[data-subfolder-id="2"]')).not.toBeNull();
    });

    it('reopens the last folder when Files is opened without ?folder=', async () => {
      window.sessionStorage.setItem(LAST_FOLDER_KEY, '1');
      window.history.replaceState(null, '', '/files');
      render(<FileManagerPage />);

      await waitFor(() => expect(new URLSearchParams(window.location.search).get('folder')).toBe('1'));
      expect(await screen.findByTestId('subfolder-grid')).toBeInTheDocument();
    });

    it('remembers the root too, so coming back does not reopen an old folder', async () => {
      window.history.replaceState(null, '', '/files?folder=1');
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await screen.findByTestId('subfolder-grid');
      expect(window.sessionStorage.getItem(LAST_FOLDER_KEY)).toBe('1');

      // The folder <select> is the phone's way up.
      await user.selectOptions(screen.getAllByRole('combobox')[0], '__top:internal');
      await waitFor(() => expect(window.location.search).toBe(''));
      expect(window.sessionStorage.getItem(LAST_FOLDER_KEY)).toBeNull();
    });
  });

  describe('version groups', () => {
    beforeEach(() => {
      files = [vase(21, 'X1C', 0, 3), vase(22, 'P1S', 1, 3), vase(23, 'A1', 2, 3), item(40, 'new_H2S.gcode.3mf', { sliced_for_model: 'H2S' })];
    });

    it('puts a removed version back where it was with Undo', async () => {
      const calls: string[] = [];
      server.use(
        http.delete('/api/v1/library/variant-groups/:id/members/:fileId', ({ params }) => {
          calls.push(`delete ${params.id}/${params.fileId}`);
          return new HttpResponse(null, { status: 204 });
        }),
        http.post('/api/v1/library/variant-groups/:id/members', async ({ params, request }) => {
          const body = (await request.json()) as { library_file_id: number };
          calls.push(`add ${params.id}/${body.library_file_id}`);
          // Appended last, as the server does.
          return HttpResponse.json({
            id: 7,
            name: 'Vase',
            members: [21, 23, 22].map((id, position) => ({ library_file_id: id, filename: `f${id}`, target_model: 'X', position })),
          });
        }),
        http.patch('/api/v1/library/variant-groups/:id', async ({ request }) => {
          calls.push(`order ${JSON.stringify(await request.json())}`);
          return HttpResponse.json({ id: 7, name: 'Vase', members: [] });
        }),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(await screen.findByRole('button', { name: 'Show versions' }));
      const line = screen.getAllByTestId('variant-member-line')[1];
      await user.click(within(line).getByRole('button', { name: /Actions for/ }));
      await user.click(await screen.findByRole('button', { name: 'Remove from group' }));

      await user.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(calls).toEqual(['delete 7/22', 'add 7/22', 'order {"member_file_ids":[21,22,23]}']),
      );
      expect(await screen.findByText('The version is back in the group')).toBeInTheDocument();
    });

    it('makes a dissolved group again under its name with Undo', async () => {
      files = [vase(21, 'X1C', 0, 2), vase(22, 'P1S', 1, 2)];
      let created: unknown = null;
      server.use(
        http.delete('/api/v1/library/variant-groups/:id/members/:fileId', () => new HttpResponse(null, { status: 204 })),
        http.post('/api/v1/library/variant-groups', async ({ request }) => {
          created = await request.json();
          return HttpResponse.json({ id: 9, name: 'Vase', members: [] }, { status: 201 });
        }),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(await screen.findByRole('button', { name: 'Show versions' }));
      const line = screen.getAllByTestId('variant-member-line')[0];
      await user.click(within(line).getByRole('button', { name: /Actions for/ }));
      await user.click(await screen.findByRole('button', { name: 'Remove from group' }));
      await user.click(await screen.findByRole('button', { name: 'Undo' }));

      await waitFor(() =>
        expect(created).toEqual({ members: [{ library_file_id: 21 }, { library_file_id: 22 }], name: 'Vase' }),
      );
    });

    it('adds a version from the group menu', async () => {
      const added: unknown[] = [];
      server.use(
        http.post('/api/v1/library/variant-groups/:id/members', async ({ params, request }) => {
          added.push({ group: params.id, ...((await request.json()) as object) });
          return HttpResponse.json({ id: 7, name: 'Vase', members: [] });
        }),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(await screen.findByRole('button', { name: 'Actions for version group Vase' }));
      await user.click(await screen.findByRole('button', { name: 'Add version…' }));

      const dialog = await screen.findByRole('dialog', { name: 'Add a version to Vase' });
      // Only the loose sliced file for a printer the group lacks.
      expect(within(dialog).getAllByRole('button').filter((b) => b.textContent?.includes('.gcode.3mf'))).toHaveLength(1);
      await user.click(within(dialog).getByRole('button', { name: /new_H2S/ }));

      await waitFor(() => expect(added).toEqual([{ group: '7', library_file_id: 40 }]));
      expect(await screen.findByText('Added new_H2S.gcode.3mf as a version')).toBeInTheDocument();
    });

    it('adds loose files to the one group selected with them', async () => {
      const added: number[] = [];
      server.use(
        http.post('/api/v1/library/variant-groups/:id/members', async ({ request }) => {
          added.push(((await request.json()) as { library_file_id: number }).library_file_id);
          return HttpResponse.json({ id: 7, name: 'Vase', members: [] });
        }),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(within(await screen.findByTestId('variant-group-card')).getByText('Vase'));
      await user.click(screen.getByText('new_H2S.gcode.3mf'));
      // Grouping anew is not offered once a group is in the selection.
      expect(screen.queryByRole('button', { name: 'Group as versions' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Add to group' }));
      await waitFor(() => expect(added).toEqual([40]));
      expect(await screen.findByText('Added to Vase: 1')).toBeInTheDocument();
    });
  });

  it('drops a ticked file from the selection once the listing no longer has it', async () => {
    files = [item(30, 'plain.gcode.3mf'), item(31, 'other.gcode.3mf')];
    const user = userEvent.setup();
    render(<FileManagerPage />);
    await user.click(await screen.findByText('plain.gcode.3mf'));
    await user.click(screen.getByText('other.gcode.3mf'));
    expect(await screen.findByText('2 selected')).toBeInTheDocument();

    // Deleted on another device; coming back to the tab fetches the listing again.
    files = [item(31, 'other.gcode.3mf')];
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(screen.queryByText('plain.gcode.3mf')).not.toBeInTheDocument());
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    focusManager.setFocused(undefined);
  });

  describe('on a touch device', () => {
    beforeEach(() => touchDevice());

    it('puts the selection actions in a bottom bar with their labels and a menu for the rest', async () => {
      files = [item(30, 'a.gcode.3mf', { sliced_for_model: 'X1C' }), item(31, 'b.gcode.3mf', { sliced_for_model: 'P1S' })];
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(await screen.findByText('a.gcode.3mf'));
      await user.click(screen.getByText('b.gcode.3mf'));

      const bar = await screen.findByTestId('selection-action-bar');
      expect(within(bar).getByRole('button', { name: 'Print (2 files)' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Move' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
      // "Group as versions" is in the menu, not a bare icon.
      expect(within(bar).queryByRole('button', { name: 'Group as versions' })).not.toBeInTheDocument();
      await user.click(within(bar).getByRole('button', { name: 'More' }));
      expect(await screen.findByRole('button', { name: 'Group as versions' })).toBeInTheDocument();
    });

    it('shows tag chips without making them filters, and opens the rest with +N', async () => {
      const tags = ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: i + 1, name }));
      files = [item(30, 'tagged.gcode.3mf', { tags })];
      const user = userEvent.setup();
      render(<FileManagerPage />);
      const stack = await screen.findByTestId('thumbnail-tags');

      expect(within(stack).queryByRole('button', { name: 'A' })).not.toBeInTheDocument();
      expect(within(stack).getAllByTestId('thumbnail-tag')).toHaveLength(3);
      await user.click(within(stack).getByRole('button', { name: 'Show all (5)' }));
      expect(within(stack).getAllByTestId('thumbnail-tag')).toHaveLength(5);
      // Opening the list neither selects the card nor filters by a tag.
      expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    });

    it('does not make folders draggable, and keeps Move in the folder menu', async () => {
      window.history.replaceState(null, '', '/files?folder=1');
      const user = userEvent.setup();
      const { container } = render(<FileManagerPage />);
      await screen.findByTestId('subfolder-grid');

      const card = container.querySelector<HTMLElement>('[data-subfolder-id="2"]')!;
      expect(card).not.toHaveAttribute('draggable');
      await user.click(within(card).getByRole('button', { name: 'Actions' }));
      expect(await screen.findByRole('button', { name: 'Move folder…' })).toBeInTheDocument();
    });
  });

  describe('on a phone', () => {
    it('folds the subfolder cards into one line while the folder has files', async () => {
      width(375);
      files = [item(30, 'inside.gcode.3mf', { folder_id: 1 })];
      window.history.replaceState(null, '', '/files?folder=1');
      const user = userEvent.setup();
      render(<FileManagerPage />);

      const toggle = await screen.findByRole('button', { name: 'Folders (1)' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('subfolder-grid')).not.toBeInTheDocument();
      await user.click(toggle);
      expect(screen.getByTestId('subfolder-grid')).toBeInTheDocument();
    });

    it('closes the versions sheet with Back instead of leaving the page', async () => {
      width(375);
      files = [vase(21, 'X1C', 0, 2), vase(22, 'P1S', 1, 2)];
      window.history.replaceState(null, '', '/files');
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(await screen.findByRole('button', { name: 'Show versions' }));
      expect(await screen.findByTestId('variant-versions-sheet')).toBeInTheDocument();
      await waitFor(() => expect(window.history.state?.modalLayer).toBeTruthy());

      act(() => window.history.back());
      await waitFor(() => expect(screen.queryByTestId('variant-versions-sheet')).not.toBeInTheDocument());
      expect(window.location.pathname).toBe('/files');
    });

    it('takes its history entry back off when the sheet is closed with its button', async () => {
      width(375);
      files = [vase(21, 'X1C', 0, 2), vase(22, 'P1S', 1, 2)];
      window.history.replaceState(null, '', '/files');
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await user.click(await screen.findByRole('button', { name: 'Show versions' }));
      await waitFor(() => expect(window.history.state?.modalLayer).toBeTruthy());

      await user.click(within(screen.getByTestId('variant-versions-sheet')).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(window.history.state?.modalLayer).toBeFalsy());
    });
  });
});
