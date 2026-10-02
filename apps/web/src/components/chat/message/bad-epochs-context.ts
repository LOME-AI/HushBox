import * as React from 'react';

/**
 * The open conversation's epochs whose own key failed verification. The chat
 * page provides it from its key verdict; a message outside that page (a shared
 * message, a test render) sees none.
 */
export const BadEpochsContext = React.createContext<ReadonlySet<number>>(new Set<number>());

/** Judges, per epoch, whether a message there was written under keys that failed verification. */
export function useWrittenUnderInvalidKeys(): (epochNumber: number | undefined) => boolean {
  const badEpochs = React.use(BadEpochsContext);
  return (epochNumber) => epochNumber !== undefined && badEpochs.has(epochNumber);
}
