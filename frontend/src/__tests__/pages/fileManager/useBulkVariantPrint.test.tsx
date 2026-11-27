/**
 * A bulk Print of several version groups (fork): the dialog says where the
 * run is, and closing one job does not silently drop the rest.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { LibraryFileListItem } from '../../../api/client';
import type { GroupRow } from '../../../pages/fileManager/variantGroups';
import { useBulkVariantPrint } from '../../../pages/fileManager/useBulkVariantPrint';

function file(id: number, groupId: number, position: number): LibraryFileListItem {
  return {
    id,
    filename: `job${id}.gcode.3mf`,
    file_type: 'gcode.3mf',
    variant_group_id: groupId,
    variant_position: position,
    variant_elsewhere: false,
    sliced_for_model: position === 0 ? 'X1C' : 'P1S',
  } as LibraryFileListItem;
}

function group(id: number, members: LibraryFileListItem[]): GroupRow {
  return { kind: 'group', id, name: `Group ${id}`, members, thumbnailFile: members[0], newest: members[0] };
}

const g1 = group(1, [file(11, 1, 0), file(12, 1, 1)]);
const g2 = group(2, [file(21, 2, 0), file(22, 2, 1)]);
const g3 = group(3, [file(31, 3, 0), file(32, 3, 1)]);
const all = [g1, g2, g3];
const selected = all.flatMap((g) => g.members.map((m) => m.id));
const selectable = new Map(all.flatMap((g) => g.members).map((m) => [m.id, m]));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const setPrintFile = vi.fn();
  const setSelectedFiles = vi.fn();
  const hook = renderHook(
    () =>
      useBulkVariantPrint({
        selectedFiles: selected,
        setSelectedFiles,
        selectableFiles: selectable,
        groupRows: all,
        selectedSlicedFiles: [...selectable.values()],
        setPrintFile,
      }),
    { wrapper },
  );
  return { ...hook, setPrintFile };
}

describe('useBulkVariantPrint chain (fork)', () => {
  it('counts the jobs and asks before dropping the rest when one is closed', async () => {
    const { result, setPrintFile } = setup();

    act(() => result.current.handleBulkPrint());
    expect(result.current.chain).toEqual({ step: 1, total: 3 });
    await waitFor(() => expect(setPrintFile).toHaveBeenLastCalledWith(g1.members[0]));

    // Closing the first job's dialog: two are left, so the page asks.
    act(() => {
      expect(result.current.closeJob()).toBe(true);
    });
    expect(result.current.discardPending).toBe(true);
    expect(result.current.remainingJobs).toBe(2);

    // "Next job" opens the second group.
    act(() => result.current.nextJob());
    expect(result.current.discardPending).toBe(false);
    expect(result.current.chain).toEqual({ step: 2, total: 3 });
    await waitFor(() => expect(setPrintFile).toHaveBeenLastCalledWith(g2.members[0]));

    // Closing again and skipping the rest ends the run.
    act(() => {
      result.current.closeJob();
    });
    act(() => result.current.discardRest());
    expect(result.current.discardPending).toBe(false);
    expect(result.current.chain).toBeNull();
    expect(result.current.remainingJobs).toBe(0);
  });

  it('closes without asking when nothing is left', async () => {
    const { result, setPrintFile } = setup();
    act(() => result.current.printVersion(g1.members[0]));
    expect(setPrintFile).toHaveBeenCalled();
    act(() => {
      expect(result.current.closeJob()).toBe(false);
    });
    expect(result.current.discardPending).toBe(false);
  });
});
