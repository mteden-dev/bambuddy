import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCcw, Tag } from 'lucide-react';

import { PrinterTagPicker } from '../PrinterTagPicker';

interface JobPrinterTagsProps {
  /** The tags the job will ask for. */
  value: number[];
  /** True when set in this dialog, false when they are the file's. */
  edited: boolean;
  onChange: (ids: number[]) => void;
  /** Go back to the file's tags; offered only while edited. */
  onReset: () => void;
  /** Tags some printer carries. */
  options: { id: number; name: string }[];
  names: Map<number, string>;
  /** "P1S" in "Any P1S" mode, null when not known (alternatives). */
  model: string | null;
  /** False when no active printer of ``model`` takes these tags. */
  somePrinterFits: boolean;
  /** "Add anyway" was chosen for tags no printer takes (the job then waits). */
  acknowledged?: boolean;
  onAcknowledge?: () => void;
}

/**
 * Printer tags of an "Any <model>" job (fork, utils/printerTags.ts): which of
 * the model's printers it may run on. Starts from the file's printer tags and
 * can be changed for this job alone.
 */
export function JobPrinterTags({
  value,
  edited,
  onChange,
  onReset,
  options,
  names,
  model,
  somePrinterFits,
  acknowledged = false,
  onAcknowledge,
}: JobPrinterTagsProps) {
  const { t } = useTranslation();
  const pickerRef = useRef<HTMLDivElement>(null);
  // "Change tags": to the picker, where the tags are changed.
  const focusPicker = () => {
    pickerRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    pickerRef.current?.querySelector<HTMLElement>('button, input, select')?.focus();
  };
  const tagList = value
    .map((id) => names.get(id))
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .join(', ');

  return (
    <div className="mb-4 space-y-1.5" data-testid="job-printer-tags">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-bambu-gray">
          <Tag className="w-3.5 h-3.5" />
          {t('printerTags.title')}
          <span className="text-bambu-gray/70">
            ({edited ? t('printerTags.jobEdited') : t('printerTags.jobFromFile')})
          </span>
        </label>
        {edited && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-bambu-green any-pointer-coarse:min-h-[44px] any-pointer-coarse:px-2"
          >
            <RotateCcw className="w-3 h-3" />
            {t('printerTags.jobReset')}
          </button>
        )}
      </div>
      <div ref={pickerRef}>
        <PrinterTagPicker value={value} onChange={onChange} options={options} />
      </div>
      <p className="text-xs text-bambu-gray">
        {value.length > 0
          ? model
            ? t('printerTags.jobInfoModel', { model, tags: tagList })
            : t('printerTags.jobInfo', { tags: tagList })
          : t('printerTags.jobInfoNone')}
      </p>
      {!somePrinterFits && model && (
        // A job no printer takes waits forever: Print stays off until the
        // tags are changed or this is chosen on purpose.
        <div
          role="alert"
          className="p-2 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-300 dark:border-yellow-500/30 rounded-lg space-y-2"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
            <span className="text-xs text-yellow-700 dark:text-yellow-400">
              {acknowledged ? t('printerTags.noPrinterFitsAccepted', { model }) : t('printerTags.noPrinterFits', { model })}
            </span>
          </div>
          {!acknowledged && onAcknowledge && (
            <div className="flex flex-wrap gap-2 pl-6">
              <button
                type="button"
                onClick={focusPicker}
                className="rounded border border-yellow-500/50 px-2 py-1 text-xs text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/10 any-pointer-coarse:min-h-[44px]"
              >
                {t('printerTags.changeTags')}
              </button>
              <button
                type="button"
                onClick={onAcknowledge}
                className="rounded border border-bambu-dark-tertiary px-2 py-1 text-xs text-bambu-gray hover:text-white any-pointer-coarse:min-h-[44px]"
              >
                {t('printerTags.addAnyway')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
