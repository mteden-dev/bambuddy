import { useTranslation } from 'react-i18next';
import { formatDuration } from '../../utils/date';
import { plateTime } from '../../utils/products';

interface PlateTimeProps {
  plate: { print_time_seconds?: number | null; planned_seconds?: number | null; learned?: boolean };
  className?: string;
}

/**
 * Fork (products): a plate's time as the plan counts it. Learnt from print
 * history it says so, with the slicer's estimate in small print, so a plan
 * that differs from the file's time is not a mystery.
 */
export function PlateTime({ plate, className = 'text-xs text-bambu-gray' }: PlateTimeProps) {
  const { t } = useTranslation();
  const { seconds, slicer } = plateTime(plate);
  if (!seconds) return null;
  if (slicer == null) return <span className={className}>{formatDuration(seconds)}</span>;
  return (
    <span className={className}>
      {t('products.learnedTime', { time: formatDuration(seconds) })}
      <span className="text-[11px] opacity-80"> · {t('products.slicerTime', { time: formatDuration(slicer) })}</span>
    </span>
  );
}
