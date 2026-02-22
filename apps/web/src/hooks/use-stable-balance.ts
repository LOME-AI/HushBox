import { useBalance } from './billing';
import { useStability } from '@/providers/stability-provider';

/**
 * Enhanced balance hook with stability tracking.
 * Returns isStable: true for trial users, or when balance loads for auth users.
 */
export function useStableBalance(): ReturnType<typeof useBalance> & {
  /** True when balance has stabilized (loaded or trial) */
  isStable: boolean;
  /** Safe display value that won't flash during loading */
  displayBalance: string;
} {
  const query = useBalance();
  const { isBalanceStable } = useStability();

  return {
    ...query,
    isStable: isBalanceStable,
    displayBalance: query.data?.balance ?? '0',
  };
}
