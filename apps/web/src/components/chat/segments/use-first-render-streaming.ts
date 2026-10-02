import * as React from 'react';

/**
 * Whether the block's message was streaming when the block first rendered.
 * Only such a block keeps a hidden status: one read from history adds no live
 * region, while one drawn during the stream keeps its status element, so its
 * milestones are announced even when a search started and finished before the
 * block was first drawn.
 */
export function useFirstRenderStreaming(isStreaming: boolean): boolean {
  const [streamingAtFirstRender] = React.useState(isStreaming);
  return streamingAtFirstRender;
}
