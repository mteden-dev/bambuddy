import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Fork (products): which orders the planner's jobs print for, one list for
 * the whole app (queue, timeline, printer cards). Refreshed with the products.
 */
export function useJobOrders() {
  return useQuery({
    queryKey: ['products', 'order-tags'],
    queryFn: api.getProductOrderTags,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}
