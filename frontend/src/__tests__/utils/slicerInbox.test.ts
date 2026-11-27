import { describe, it, expect } from 'vitest';
import type { LibraryFolderTree, PendingSlicerUpload } from '../../api/client';
import {
  flattenFolders,
  folderPathLabel,
  isOwnClaim,
  keepTargets,
  newDecisionClaim,
  nextPendingUpload,
  quickQueueItem,
} from '../../utils/slicerInbox';

function upload(id: number, over: Partial<PendingSlicerUpload> = {}): PendingSlicerUpload {
  return {
    id, filename: `f${id}.gcode.3mf`, folder_id: 1, plate: null, print: false, sliced_for_model: 'X1C',
    print_time_seconds: null, filament_used_grams: null, created_at: '2026-11-17T00:00:00Z', ...over,
  };
}

function folder(id: number, name: string, children: LibraryFolderTree[] = [], over: Partial<LibraryFolderTree> = {}) {
  return {
    id, name, parent_id: null, project_id: null, archive_id: null, project_name: null, archive_name: null,
    is_external: false, external_path: null, external_readonly: false, file_count: 0, latest_activity_at: null,
    created_by_id: 1, shared: true, can_write: true, can_rename: true, can_delete: true, children, ...over,
  } as LibraryFolderTree;
}

describe('nextPendingUpload', () => {
  it('is the oldest one not set aside', () => {
    expect(nextPendingUpload([upload(1), upload(2)], new Set())?.id).toBe(1);
    expect(nextPendingUpload([upload(1), upload(2)], new Set([1]))?.id).toBe(2);
    expect(nextPendingUpload([upload(1)], new Set([1]))).toBeNull();
    expect(nextPendingUpload(undefined, new Set())).toBeNull();
  });
});

describe('quickQueueItem', () => {
  it('queues any printer of the model, at the end, removed after dispatch', () => {
    expect(quickQueueItem(upload(5, { plate: 3 }), false)).toEqual({
      library_file_id: 5,
      target_model: 'X1C',
      plate_id: 3,
      cleanup_library_after_dispatch: true,
      manual_start: false,
    });
    expect(quickQueueItem(upload(5), true)).toMatchObject({ plate_id: null, manual_start: true });
  });

  it('has nothing to queue for without a model', () => {
    expect(quickQueueItem(upload(5, { sliced_for_model: null }), false)).toBeNull();
  });
});

describe('folders', () => {
  const tree = [
    folder(2, 'b', [folder(4, 'child', [], { parent_id: 2 })]),
    folder(1, 'a'),
    folder(3, 'nas', [], { is_external: true, external_readonly: true }),
    folder(5, 'theirs', [], { can_write: false }),
  ];

  it('flattens in name order with depth', () => {
    expect(flattenFolders(tree).map((o) => [o.name, o.depth])).toEqual([
      ['a', 0], ['b', 0], ['child', 1], ['nas', 0], ['theirs', 0],
    ]);
  });

  it('offers writable folders other than the inbox', () => {
    expect(keepTargets(tree, 1).map((o) => o.name)).toEqual(['b', 'child']);
  });

  it('labels a folder with its whole path, so two of one name differ (fork)', () => {
    const twins = [folder(6, 'H2S', [folder(7, 'Boxes', [], { parent_id: 6 })]), folder(8, 'P1S', [folder(9, 'Boxes', [], { parent_id: 8 })])];
    expect(flattenFolders(twins).map(folderPathLabel)).toEqual(['H2S', 'H2S / Boxes', 'P1S', 'P1S / Boxes']);
  });
});

describe('decision claims (fork)', () => {
  it('are new for every decision and recognised as this tab’s own', () => {
    const a = newDecisionClaim();
    const b = newDecisionClaim();
    expect(a).not.toBe(b);
    expect(isOwnClaim(a)).toBe(true);
    expect(isOwnClaim('another-tab:1')).toBe(false);
    expect(isOwnClaim(null)).toBe(false);
  });

  it('go with the one-click queue item', () => {
    expect(quickQueueItem(upload(5), false, 'tab:3')).toMatchObject({ slicer_inbox_claim: 'tab:3' });
    expect(quickQueueItem(upload(5), false)).not.toHaveProperty('slicer_inbox_claim');
  });
});
