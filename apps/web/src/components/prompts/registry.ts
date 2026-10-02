import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import { useChannelPromptEligibility } from '@/components/prompts/channel-prompt';
import { NotificationEnablePrompt } from '@/components/notifications/enable-prompt';
import { NotificationEnablePromptRail } from '@/components/notifications/enable-prompt-rail';
import { ChannelPrompt, ChannelPromptRail } from '@/components/prompts/channel-prompt';
import type * as React from 'react';

/**
 * One prompt the sidebar slot can show: whether this account or device is owed
 * it, the card the expanded sidebar renders, and the stand-in the 48px rail
 * carries instead.
 */
export interface PromptDefinition {
  readonly id: string;
  /** Called as a hook, so a definition may ask a query or the platform. */
  readonly useEligible: () => boolean;
  readonly Card: () => React.JSX.Element | null;
  readonly Rail: () => React.JSX.Element | null;
}

/**
 * The prompts, in priority order — the slot shows the first eligible one and
 * nothing else, so this list is the whole of the coordination between them.
 *
 * Notifications comes first because it is time-sensitive in a way a survey is
 * not: the platform permission dialog can only be raised from a gesture on the
 * offer, and a browser that has been asked once will not ask again. The channel
 * question waits its turn and is asked again at first payment regardless.
 *
 * Every entry's hook runs on every render, signed in or not, so a definition
 * that asks the server about the account gates its query on a session.
 *
 * A future question is one more entry here.
 */
export const PROMPT_REGISTRY: readonly PromptDefinition[] = [
  {
    id: 'notifications',
    useEligible: () => useEnablePrompt().isVisible,
    Card: NotificationEnablePrompt,
    Rail: NotificationEnablePromptRail,
  },
  {
    id: 'acquisition-channel',
    useEligible: useChannelPromptEligibility,
    Card: ChannelPrompt,
    Rail: ChannelPromptRail,
  },
];
