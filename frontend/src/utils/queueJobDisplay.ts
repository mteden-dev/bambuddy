import { api } from '../api/client';
import type { PrintQueueItem, QueueForecastVariant } from '../api/client';
import { queueItemThumbnailUrl } from './queueItemThumbnail';

/**
 * What a queued job prints, for the timeline and its details (fork). A job with
 * printer alternatives (#671) has no file of its own until it starts: the
 * forecast says which alternative its expected printer takes, and that file's
 * name, thumbnail and print time stand for the job.
 */

function firstVariant(item: PrintQueueItem) {
  return [...(item.variants ?? [])].sort((a, b) => a.position - b.position)[0];
}

export function queueJobName(item: PrintQueueItem, variant?: QueueForecastVariant | null): string {
  return (
    variant?.name
    || item.archive_name
    || item.library_file_name
    || firstVariant(item)?.filename
    || `#${item.id}`
  );
}

export function queueJobThumbnailUrl(item: PrintQueueItem, variant?: QueueForecastVariant | null): string | null {
  if (!variant) return queueItemThumbnailUrl(item);
  if (!variant.has_thumbnail) return null;
  return variant.plate_id != null
    ? api.getLibraryFilePlateThumbnail(variant.library_file_id, variant.plate_id)
    : api.getLibraryFileThumbnailUrl(variant.library_file_id);
}

export function queueJobPrintTime(item: PrintQueueItem, variant?: QueueForecastVariant | null): number | null {
  return variant?.print_time_seconds ?? item.print_time_seconds ?? null;
}

/** The models an "Any" job may run on: its alternatives' or its target model. */
export function queueJobModels(item: PrintQueueItem): string[] {
  if (item.variants && item.variants.length > 0) {
    return [...item.variants].sort((a, b) => a.position - b.position).map((v) => v.target_model);
  }
  return item.target_model ? [item.target_model] : [];
}
