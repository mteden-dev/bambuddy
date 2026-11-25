import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { PrintQueueItem } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';

interface QueueStartButtonProps {
  item: Pick<PrintQueueItem, 'id' | 'created_by_id'>;
  className?: string;
}

type Deficit = { slot_id: number; required_grams: number; remaining_grams: number | null };

/**
 * Fork: Start for a job waiting for it (manual start), anywhere outside the
 * queue page (the printer card). Same flow as the queue's button: the server
 * checks the filament again and, when it is still short or not loaded, asks
 * before starting anyway.
 */
export function QueueStartButton({ item, className = '' }: QueueStartButtonProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canModify, hasAnyPermission } = useAuth();
  const [short, setShort] = useState<Deficit[] | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const allowed =
    canModify('queue', 'update', item.created_by_id) && hasAnyPermission('queue:update_all', 'queue:start_unreviewed');

  const start = useMutation({
    mutationFn: (skipFilamentCheck: boolean) => api.startQueueItem(item.id, { skipFilamentCheck }),
    onSuccess: () => {
      setShort(null);
      setMissing(null);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      showToast(t('queue.toast.released'));
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 409 && error.code === 'insufficient_filament') {
        setShort((error.detail?.deficit ?? []) as Deficit[]);
        return;
      }
      if (error instanceof ApiError && error.status === 409 && error.code === 'unmatched_filament') {
        setMissing((error.detail?.missing ?? []) as string[]);
        return;
      }
      showToast(t('queue.toast.startFailed'), 'error');
    },
  });

  return (
    <>
      <Button
        size="sm"
        className={`pointer-coarse:min-h-11! ${className}`}
        disabled={!allowed || start.isPending}
        title={allowed ? t('queue.actions.startPrint') : t('queue.permissions.noStartPrint')}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          start.mutate(false);
        }}
      >
        {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {t('queue.hold.start')}
      </Button>
      {short && (
        <ConfirmModal
          title={t('queue.filamentShort.confirmTitle')}
          message={
            t('queue.filamentShort.confirmIntro') +
            '\n\n' +
            short
              .map((d) =>
                t('queue.filamentShort.lineItem', {
                  slot: d.slot_id,
                  required: Math.round(d.required_grams),
                  remaining: d.remaining_grams == null ? t('queue.filamentShort.unknown') : Math.round(d.remaining_grams),
                }),
              )
              .join('\n')
          }
          confirmText={t('queue.filamentShort.printAnyway')}
          variant="warning"
          isLoading={start.isPending}
          onConfirm={() => start.mutate(true)}
          onCancel={() => setShort(null)}
        />
      )}
      {missing && (
        <ConfirmModal
          title={t('queue.filamentMissing.confirmTitle')}
          message={t('queue.filamentMissing.confirmIntro') + '\n\n' + missing.join('\n')}
          confirmText={t('queue.filamentShort.printAnyway')}
          variant="warning"
          isLoading={start.isPending}
          onConfirm={() => start.mutate(true)}
          onCancel={() => setMissing(null)}
        />
      )}
    </>
  );
}
