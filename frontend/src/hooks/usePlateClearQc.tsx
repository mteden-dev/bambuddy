import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { api } from '../api/client';
import type { ProductQcJob } from '../api/client';
import { PlateQcModal, PrinterQcModal } from '../components/products/ProductQc';

interface PlateClearQc {
  /** Clears at once when nothing on the plate waits to be checked, otherwise after the answer. */
  beforeClear: (clear: () => void) => void;
  /** Looking up what is on the plate: the clear button waits (and a second tap does nothing). */
  checking: boolean;
  /** The question (or the printer's list); render it anywhere in the card. */
  modal: ReactNode;
  /** "2 to check": opens the printer's list without clearing the plate; null when none wait. */
  badge: ReactNode;
}

/**
 * Fork (products): the products a printer made, checked where the operator
 * stands. Before "Plate cleared" it asks about the plate on the printer only
 * (prints set aside earlier wait in the list); "later" clears too, closing
 * the question clears nothing.
 */
export function usePlateClearQc(printerId: number, printerName: string | null, canAct: boolean): PlateClearQc {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<{ job: ProductQcJob; olderCount: number; clear: () => void } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [checking, setChecking] = useState(false);
  // One list for every card (and the menu): React Query asks once.
  const { data: waiting } = useQuery({
    queryKey: ['products', 'qc'],
    queryFn: () => api.getProductsToCheck(),
    refetchInterval: 60_000,
    retry: false,
  });
  const count = (waiting ?? []).filter((job) => job.printer_id === printerId).length;

  const beforeClear = (clear: () => void) => {
    if (checking) return;
    setChecking(true);
    queryClient
      .fetchQuery({
        queryKey: ['products', 'qc', 'plate', printerId],
        queryFn: () => api.getProductsToCheck(printerId, { onPlate: true }),
        staleTime: 0,
      })
      .then(
        ([job]) => {
          if (!job || !canAct) {
            clear();
            return;
          }
          const olderCount = (waiting ?? []).filter((j) => j.printer_id === printerId && j.id !== job.id).length;
          setAsking({ job, olderCount, clear });
        },
        () => clear(),
      )
      .finally(() => setChecking(false));
  };

  let modal: ReactNode = null;
  if (asking) {
    modal = (
      <PlateQcModal
        job={asking.job}
        olderCount={asking.olderCount}
        printerName={printerName}
        onClose={() => setAsking(null)}
        onDone={() => {
          const { clear } = asking;
          setAsking(null);
          clear();
        }}
      />
    );
  } else if (reviewing) {
    modal = (
      <PrinterQcModal
        printerId={printerId}
        printerName={printerName}
        canAct={canAct}
        onClose={() => setReviewing(false)}
      />
    );
  }

  const badge =
    count > 0 ? (
      <button
        type="button"
        onClick={() => setReviewing(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 pointer-coarse:py-2 rounded-full text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25"
      >
        <ClipboardCheck className="w-3.5 h-3.5" />
        {t('products.qc.printerBadge', { count })}
      </button>
    ) : null;

  return { beforeClear, checking, modal, badge };
}
