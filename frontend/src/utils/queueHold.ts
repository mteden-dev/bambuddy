import type { PrintQueueItem } from '../api/client';
import { translateWaitingReason } from './serverMessages';

type T = (key: string, options?: Record<string, unknown>) => string;

/** Why a waiting job will not start by itself: it waits for someone to press Start. */
export interface QueueHold {
  /** Held by a problem the scheduler found (the spool is short, a filament is not loaded), not staged on purpose. */
  problem: boolean;
  text: string;
}

/**
 * Fork: a pending job with manual start never starts by itself. The scheduler
 * turns it on when the assigned spool is too short (``filament_short``) or the
 * printer has no slot with a filament the file needs (a ``waiting_reason``);
 * otherwise it was staged on purpose. Null for a job that will start.
 */
export function queueHold(
  item: Pick<PrintQueueItem, 'status' | 'manual_start' | 'filament_short' | 'waiting_reason'>,
  t: T,
): QueueHold | null {
  if (item.status !== 'pending' || !item.manual_start) return null;
  if (item.filament_short) return { problem: true, text: t('queue.filamentShort.rowBadge') };
  if (item.waiting_reason) return { problem: true, text: translateWaitingReason(item.waiting_reason, t) };
  return { problem: false, text: t('queue.hold.staged') };
}
