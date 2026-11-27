import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidatePlanQueries, PRODUCTS_REPLANNED_EVENT } from '../../utils/products';

/**
 * Fork (products): a plan made anywhere (another tab, the queue, a Base read)
 * reaches the open page: the app sends PRODUCTS_REPLANNED_EVENT after every
 * plan, and what a plan changes is read again.
 */
export function useProductsReplanned(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const onReplanned = () => invalidatePlanQueries(queryClient);
    window.addEventListener(PRODUCTS_REPLANNED_EVENT, onReplanned);
    return () => window.removeEventListener(PRODUCTS_REPLANNED_EVENT, onReplanned);
  }, [queryClient]);
}
