import { TEST_IDS } from '@hushbox/shared';
import { useIsSettled } from '@/hooks/ui/use-is-settled';

export function SettledIndicator(): React.JSX.Element {
  const settled = useIsSettled();

  return <div data-testid={TEST_IDS.settledIndicator} data-settled={String(settled)} hidden />;
}
