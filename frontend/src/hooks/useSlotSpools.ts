import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/**
 * Fork (slot spools): the printer card's data for a roll counted per AMS slot.
 * The rules for which slot lights up are in utils/slotSpools.
 */

/** Slots waiting for "same roll?", as a lookup. Refetched on the backend's websocket event. */
export function useSlotSpoolPrompts(enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['slot-spool-prompts'],
    queryFn: api.getSlotSpoolPrompts,
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 120_000 : false,
  });
  return useCallback(
    (printerId: number, amsId: number, trayId: number) =>
      !!data?.some((p) => p.printer_id === printerId && p.ams_id === amsId && p.tray_id === trayId),
    [data],
  );
}

/** "Same roll": keep counting on the slot's spool. */
export function useKeepSameRoll() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ printerId, amsId, trayId }: { printerId: number; amsId: number; trayId: number }) =>
      api.keepSameSlotRoll(printerId, amsId, trayId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['slot-spool-prompts'] });
      // No prompt left to clear: the slot went empty again or a new roll was
      // set up meanwhile, so "still counting on the same roll" would be untrue.
      if (result?.cleared === false) showToast(t('slotSpool.toastSameGone'), 'info');
      else showToast(t('slotSpool.toastSame'), 'success');
    },
    onError: (error: Error) => showToast(t('slotSpool.saveFailed', { error: error.message }), 'error'),
  });
}
