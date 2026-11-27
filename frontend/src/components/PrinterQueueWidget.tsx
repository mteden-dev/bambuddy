import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, Calendar, ChevronRight, Hand } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { formatRelativeTime } from '../utils/date';
import { filterCompatibleQueueItems } from '../utils/printer';
import { queueItemDisplayName } from '../utils/queueItemName';
import { queueHold } from '../utils/queueHold';
import { QueueStartButton } from './QueueStartButton';
import { withColorSquares } from '../utils/colorSquares';

interface PrinterQueueWidgetProps {
  printerId: number;
  printerModel?: string | null;
  loadedFilamentTypes?: Set<string>;
  loadedFilaments?: Set<string>;  // "TYPE:rrggbb" pairs for filament override color matching
  loadedVariants?: Set<string>;  // "TYPE:rrggbb:idx" triples for PLA sub-variant matching (#2650)
  variant?: 'card' | 'panelExtension';
}

export function PrinterQueueWidget({ printerId, printerModel, loadedFilamentTypes, loadedFilaments, loadedVariants, variant = 'card' }: PrinterQueueWidgetProps) {
  const { t } = useTranslation();
  const { data: queue } = useQuery({
    queryKey: ['queue', printerId, 'pending', printerModel],
    // The printer's model is resolved on the server, as GET /queue/ does when
    // no target_model is given; the key keeps it so a model change refetches.
    queryFn: () => api.getPrinterQueue(printerId, 'pending'),
    refetchInterval: 30000,
  });

  // Filter queue to items this printer can actually print (filament type + color check)
  const compatibleQueue = queue ? filterCompatibleQueueItems(queue, loadedFilamentTypes, loadedFilaments, loadedVariants) : undefined;
  const totalPending = compatibleQueue?.length || 0;

  if (totalPending === 0) {
    return null;
  }

  const nextItem = compatibleQueue?.[0];
  // Fork: a next job waiting for Start (the spool is short, a filament is not
  // loaded, or it was staged) never starts by itself, plate cleared or not:
  // say why, and offer Start here.
  const hold = nextItem ? queueHold(nextItem, t) : null;

  // Passive next-in-queue preview. Plate-clear acknowledgment is handled by the
  // card-level "Mark plate as cleared" button (PrintersPage.tsx). Having a
  // second button in this widget caused the two controls to overlap whenever
  // the plate-clear gate was up with auto-dispatch items queued — both POSTed
  // to the same /clear-plate endpoint, so the widget button was pure noise.
  const tone = hold?.problem
    ? 'border border-red-400/60 bg-red-500/10'
    : hold
      ? 'border border-purple-400/40 bg-purple-500/10'
      : '';
  const containerClassName = variant === 'panelExtension'
    ? hold
      ? `mt-2 rounded-lg p-2 ${tone}`
      : 'mt-2 border-t border-bambu-dark-tertiary pt-2 pl-1'
    : hold
      ? `mb-3 p-3 rounded-lg ${tone}`
      : 'mb-3 p-3 bg-bambu-dark rounded-lg hover:bg-bambu-dark-tertiary transition-colors';

  return (
    <div className={containerClassName} data-testid="printer-queue-widget" data-hold={hold ? (hold.problem ? 'problem' : 'staged') : undefined}>
      <Link to="/queue" className="flex items-center justify-between gap-3 hover:opacity-90 transition-opacity">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {hold?.problem ? (
            <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0" />
          ) : hold ? (
            <Hand className="w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
          ) : (
            <Calendar className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs text-bambu-gray">{hold ? t('queue.hold.nextWaits') : t('queue.nextInQueue')}</p>
            <p className="text-sm text-white truncate">
              {nextItem ? queueItemDisplayName(nextItem) : ''}
            </p>
            {hold && (
              <p className={`text-xs mt-0.5 ${hold.problem ? 'text-red-600 dark:text-red-300' : 'text-purple-700 dark:text-purple-300'}`}>
                {withColorSquares(hold.text)}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!hold && (
            <span className="text-xs text-bambu-gray flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {nextItem?.scheduled_time ? formatRelativeTime(nextItem.scheduled_time, 'system', t) : t('time.waiting')}
            </span>
          )}
          {totalPending > 1 && (
            <span className="text-xs px-1.5 py-0.5 bg-yellow-100 dark:bg-yellow-400/20 text-yellow-700 dark:text-yellow-400 rounded">
              +{totalPending - 1}
            </span>
          )}
          <ChevronRight className="w-4 h-4 text-bambu-gray" />
        </div>
      </Link>
      {hold && nextItem && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[11px] text-bambu-gray mr-auto">{t('queue.hold.wontStart')}</span>
          <QueueStartButton item={nextItem} />
        </div>
      )}
    </div>
  );
}
