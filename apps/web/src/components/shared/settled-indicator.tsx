import { useIsSettled } from '@/hooks/use-is-settled';

export function SettledIndicator(): React.JSX.Element {
  const settled = useIsSettled();

  return <div data-testid="settled-indicator" data-settled={String(settled)} hidden />;
}
