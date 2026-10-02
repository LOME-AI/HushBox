import * as React from 'react';
import { OTHERS_COLOR, formatDelta, formatShare, type RankedModel } from './compute-stats';

interface RankedListProps {
  readonly models: readonly RankedModel[];
  readonly others: { readonly sharePercent: number; readonly deltaPoints: number | null };
  readonly showDelta: boolean;
}

/**
 * Ranked model-share list; doubles as the text alternative for the trend
 * chart. Others always closes the list. Delta badges appear only when the
 * window has a prior comparison window and the row carries a delta.
 */
export function RankedList({ models, others, showDelta }: RankedListProps): React.JSX.Element {
  return (
    <ol aria-label="Model share ranking" className="@container flex flex-col">
      {models.map((model) => (
        <Row
          key={model.modelId}
          rank={String(model.rank)}
          color={model.color}
          label={model.displayName}
          provider={model.provider}
          share={model.sharePercent}
          delta={showDelta ? model.deltaPoints : null}
        />
      ))}
      {others.sharePercent !== 0 && (
        <Row
          rank=""
          color={OTHERS_COLOR}
          label="Others"
          share={others.sharePercent}
          delta={showDelta ? others.deltaPoints : null}
        />
      )}
    </ol>
  );
}

interface RowProps {
  readonly rank: string;
  readonly color: string;
  readonly label: string;
  readonly provider?: string;
  readonly share: number;
  readonly delta: number | null;
}

// Every row wraps together once the list is narrower than 11.7em: the one-line
// row's fixed parts (rank 1.25, key 0.75, share 4, three row gaps and the figures'
// gap at 0.75 each) are 9rem, plus a six-character delta at 0.75rem and 0.6em per
// mono character (2.7rem). Below it the name would give way to nothing.
function Row({ rank, color, label, provider, share, delta }: RowProps): React.JSX.Element {
  return (
    <li className="border-border flex items-center gap-x-3 gap-y-1 border-b py-2.5 text-sm last:border-b-0 @max-[11.7em]:flex-wrap">
      <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-xs tabular-nums">
        {rank}
      </span>
      <span
        data-key
        aria-hidden="true"
        style={{ '--key': color } as React.CSSProperties}
        className="size-3 shrink-0 rounded-[3px] bg-(--key) forced-color-adjust-none"
      />
      <span className="text-foreground min-w-0 flex-1 truncate">
        {label}
        {provider !== undefined && (
          <small className="text-muted-foreground @mkt-list-provider:inline ml-2 hidden text-xs">
            {provider}
          </small>
        )}
      </span>
      {/* One unit, so a wrapped row carries both figures on a line of their own. */}
      <span className="ml-auto flex shrink-0 items-center gap-3 @max-[11.7em]:basis-full @max-[11.7em]:justify-end">
        {delta !== null && (
          // Positive deltas use default ink in light mode: light --success on the
          // warm paper background measures ~3.13:1 at this size, under the 4.5:1
          // AA floor, and no committed token offers a stronger success shade. The
          // sign already carries the meaning. Dark --success measures ~7.7:1, so
          // dark mode keeps the green. A delta that rounds to zero shows as flat.
          <span
            className={`font-mono text-xs tabular-nums ${Math.round(delta * 10) > 0 ? 'text-foreground dark:text-success' : 'text-muted-foreground'}`}
          >
            {formatDelta(delta)}
          </span>
        )}
        <span className="text-foreground w-16 shrink-0 text-right font-mono tabular-nums">
          {formatShare(share)}
        </span>
      </span>
    </li>
  );
}
