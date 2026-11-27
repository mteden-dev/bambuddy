/**
 * Fork: Settings → sending from OrcaSlicer. The folder list names each folder
 * by its path, and copying the address over plain http (no clipboard) selects
 * it and says so instead of doing nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SlicerUploadSettings } from '../../components/SlicerUploadSettings';

function folder(id: number, name: string, children: unknown[] = [], parentId: number | null = null) {
  return {
    id, name, parent_id: parentId, project_id: null, archive_id: null, project_name: null, archive_name: null,
    is_external: false, external_path: null, external_readonly: false, file_count: 0, latest_activity_at: null,
    created_by_id: 1, shared: true, can_write: true, can_rename: true, can_delete: true, children,
  };
}

const originalClipboard = navigator.clipboard;

beforeEach(() => {
  server.use(
    http.get('/api/v1/settings/', () =>
      HttpResponse.json({ currency: 'USD', slicer_inbox_folder_id: null, slicer_inbox_manual_start: false }),
    ),
    http.get('/api/v1/library/folders', () =>
      HttpResponse.json([
        folder(1, 'H2S', [folder(2, 'Boxes', [], 1)]),
        folder(3, 'P1S', [folder(4, 'Boxes', [], 3)]),
      ]),
    ),
  );
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
});

describe('SlicerUploadSettings', () => {
  it('names each inbox folder by its path, so two folders of one name differ', async () => {
    render(<SlicerUploadSettings />);
    expect(await screen.findByRole('option', { name: 'H2S / Boxes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'P1S / Boxes' })).toBeInTheDocument();
  });

  it('selects the address and says so when the clipboard is not available', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('not allowed')) },
      configurable: true,
    });
    render(<SlicerUploadSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy address' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copying needs https');
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(window.location.origin));
  });
});
