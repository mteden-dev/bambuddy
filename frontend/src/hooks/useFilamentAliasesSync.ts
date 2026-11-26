import { useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { getFilamentAliasesVersion, setFilamentAliases, subscribeFilamentAliases } from '../utils/filamentAliases';

export const FILAMENT_ALIASES_QUERY_KEY = ['filament-aliases'] as const;

/**
 * Fork (filament aliases): keep the colours and profiles marked as the same in
 * utils/filamentAliases, for the matching hints. Use it once, in Layout: the
 * returned version changes when the groups do, so the page re-renders.
 */
export function useFilamentAliasesSync(enabled: boolean): number {
  const { data } = useQuery({
    queryKey: FILAMENT_ALIASES_QUERY_KEY,
    queryFn: api.getFilamentAliases,
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  useEffect(() => {
    if (data) setFilamentAliases(data);
  }, [data]);
  return useSyncExternalStore(subscribeFilamentAliases, getFilamentAliasesVersion, getFilamentAliasesVersion);
}
