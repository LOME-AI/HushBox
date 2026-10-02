import * as React from 'react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';

import { Card, CardContent } from '../primitives/card';

function StatTileSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div
        className="bg-muted h-4 w-20 animate-pulse rounded"
        data-testid={TEST_IDS.skeletonBlock}
      />
      <div
        className="bg-muted h-7 w-24 animate-pulse rounded"
        data-testid={TEST_IDS.skeletonBlock}
      />
    </div>
  );
}

/** One headline figure: icon, label, value, and its own loading placeholder. */
function StatTile({
  icon,
  label,
  value,
  isLoading,
  testId,
  ...props
}: Readonly<
  React.ComponentProps<typeof Card> & {
    icon: React.ReactNode;
    label: string;
    value: string;
    isLoading: boolean;
    testId: string;
  }
>): React.JSX.Element {
  return (
    <Card data-slot="stat-tile" data-testid={testId} {...props}>
      <CardContent className="px-4 pt-3 pb-3">
        {isLoading ? (
          <StatTileSkeleton />
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground">{icon}</div>
            <div>
              <p className="text-muted-foreground text-xs">{label}</p>
              <p
                className="text-foreground text-xl font-semibold tabular-nums"
                data-testid={TEST_ID_BUILDERS.kpiValue(testId)}
              >
                {value}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { StatTile };
