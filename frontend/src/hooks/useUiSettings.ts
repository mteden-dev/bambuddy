import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, type UiSettings } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

/**
 * The install settings a page needs to render, for any signed-in user.
 *
 * GET /settings needs settings:read, and a user without it got a 403 that left
 * every value at its fallback. Such a user reads the subset served without
 * that permission instead; everyone else keeps the full settings, under the
 * same query key as before.
 */
export function useUiSettings(options: { enabled?: boolean; staleTime?: number } = {}) {
  const { hasPermission } = useAuth();
  const readsAll = hasPermission('settings:read');
  return useQuery<UiSettings>({
    queryKey: readsAll ? ['settings'] : ['ui-settings'],
    queryFn: readsAll ? () => api.getSettings() : () => api.getUiSettings(),
    ...options,
  });
}

/** Whether G-code snippets are set up, from either form of the settings. */
export function hasGcodeSnippets(settings: UiSettings | undefined): boolean {
  return !!(settings?.gcode_snippets || settings?.has_gcode_snippets);
}

/**
 * Show saved setting values at once in both cache shapes useUiSettings may be
 * reading from, then refetch them so a change made elsewhere in the meantime
 * (another tab or administrator) is not kept out of view. Caches not loaded
 * yet are left alone.
 */
export function applySavedUiSettings(queryClient: QueryClient, patch: Partial<UiSettings>) {
  const merge = (old: UiSettings | undefined) => old && { ...old, ...patch };
  for (const queryKey of [['settings'], ['ui-settings']]) {
    queryClient.setQueryData<UiSettings>(queryKey, merge);
    void queryClient.invalidateQueries({ queryKey });
  }
}
