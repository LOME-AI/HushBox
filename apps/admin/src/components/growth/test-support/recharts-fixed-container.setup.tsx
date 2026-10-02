import * as React from 'react';

/**
 * `recharts` with a `ResponsiveContainer` that reports a fixed box. The real one
 * measures its parent, and the test runtime gives it no layout to measure.
 *
 * It sits apart from `apps/admin/src/components/growth/test-support/growth-screen-harness.setup.tsx`
 * because the `vi.mock` factory that calls it runs while that module is still
 * evaluating: the harness imports the screen, and the screen imports
 * `recharts`. A module the factory reaches has to be one the screen's own
 * import graph cannot lead back into.
 *
 * Its name carries the same two markers as the harness beside it, which states
 * what each one buys.
 */
export function rechartsWithFixedContainer(actual: typeof import('recharts')): Omit<
  typeof import('recharts'),
  'ResponsiveContainer'
> & {
  ResponsiveContainer: (props: { children: React.ReactNode }) => React.ReactElement;
} {
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 220 }}>
        {React.cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
          width: 800,
          height: 220,
        })}
      </div>
    ),
  };
}
