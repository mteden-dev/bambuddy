import { useCallback, useEffect, useRef } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';

// The folder last open in this tab, for coming back to Files from another
// page through a link without ?folder=.
export const LAST_FOLDER_KEY = 'fileManager.lastFolder';

function readLastFolder(): number | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_FOLDER_KEY);
    const id = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function writeLastFolder(id: number | null) {
  try {
    if (id === null) window.sessionStorage.removeItem(LAST_FOLDER_KEY);
    else window.sessionStorage.setItem(LAST_FOLDER_KEY, String(id));
  } catch {
    // Storage blocked: coming back starts at the root, nothing else breaks.
  }
}

export type SelectFolder = (id: number | null, options?: { replace?: boolean }) => void;

/**
 * Fork: the open folder is the URL's `?folder=`. Opening one pushes a history
 * entry, so Back (or the swipe on a phone or iPad) goes back up instead of
 * leaving Files; a reload keeps it; and opening Files without the parameter
 * goes back to the folder last open in this tab.
 */
export function useFolderInUrl(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
): { selectedFolderId: number | null; setSelectedFolderId: SelectFolder } {
  const raw = searchParams.get('folder');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const selectedFolderId = Number.isFinite(parsed) ? parsed : null;
  const currentRef = useRef(selectedFolderId);
  currentRef.current = selectedFolderId;
  // The router's setter changes with every URL; this one stays the same, so
  // effects that open a folder do not re-run on every navigation.
  const setParamsRef = useRef(setSearchParams);
  setParamsRef.current = setSearchParams;

  const setSelectedFolderId = useCallback<SelectFolder>(
    (id, options) => {
      if (id === currentRef.current) return;
      currentRef.current = id;
      setParamsRef.current(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === null) next.delete('folder');
          else next.set('folder', String(id));
          // A ?highlight= link is spent once a folder opens; kept, a reload
          // or Back would pull the user to that file again.
          next.delete('highlight');
          return next;
        },
        { replace: options?.replace },
      );
    },
    [],
  );

  // Coming back without ?folder= reopens the last folder, as a replace so
  // Back does not land on the root first.
  useEffect(() => {
    if (raw) return;
    const last = readLastFolder();
    if (last !== null) setSelectedFolderId(last, { replace: true });
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const arrivedRef = useRef(false);
  useEffect(() => {
    // The first render at the root may be about to restore: do not wipe the
    // remembered folder before it has been read.
    if (!arrivedRef.current) {
      arrivedRef.current = true;
      if (selectedFolderId === null) return;
    }
    writeLastFolder(selectedFolderId);
  }, [selectedFolderId]);

  return { selectedFolderId, setSelectedFolderId };
}
