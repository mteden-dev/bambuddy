import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api, type PrintQueueItem } from '../api/client';
import { queueItemTagsQueryKey, usePrinterTags } from '../utils/printerTags';
import { PrinterTagChips } from './PrinterTagPicker';

/**
 * The printer tags an "Any <model>" queue job asks for (fork,
 * utils/printerTags.ts). Nothing for a job sent to one printer, or asking for none.
 */
export function QueueItemTagChips({ item }: { item: Pick<PrintQueueItem, 'id' | 'printer_id' | 'status'> }) {
  const { t } = useTranslation();
  const routed = item.printer_id == null && item.status === 'pending';
  const { data } = useQuery({
    queryKey: queueItemTagsQueryKey,
    queryFn: api.getQueueItemTags,
    enabled: routed,
    staleTime: 15_000,
  });
  const entry = routed ? data?.find((e) => e.queue_item_id === item.id) : undefined;
  const { names } = usePrinterTags(!!entry && entry.tag_ids.length > 0);
  if (!entry || entry.tag_ids.length === 0) return null;
  return (
    <PrinterTagChips
      tagIds={entry.tag_ids}
      names={names}
      title={entry.overridden ? t('printerTags.queueChipEdited') : t('printerTags.queueChip')}
    />
  );
}
