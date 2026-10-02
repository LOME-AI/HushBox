import * as React from 'react';

/**
 * Names the member a group reply answers. Below 768px it takes a row of its own
 * in the nameplate, which works only while the nameplate row wraps.
 */
export function ReplyingTo({ name }: Readonly<{ name: string }>): React.JSX.Element {
  return (
    <span className="text-muted-foreground inline-flex max-w-full min-w-0 gap-1 text-xs whitespace-nowrap max-md:basis-full">
      replying to <span className="text-foreground truncate font-semibold">{name}</span>
    </span>
  );
}
