import * as React from 'react';
import { useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { Button, PromptCard } from '@hushbox/ui';
import { GROWTH_CHANNELS } from '@hushbox/shared';
import { useExpandSidebar } from '@/hooks/ui/use-sidebar-rail';
import { useAcquisitionSource, useSelfReport } from '@/hooks/growth/use-acquisition-source';
import type { GrowthChannel, GrowthSelfReportContext } from '@hushbox/shared';

/**
 * The eight answers, in the closed set's own order. The labels are the only
 * thing here the set does not fix: `friend` and `article` read as one word in
 * the database and as a phrase to a person.
 */
const CHANNEL_LABELS: Readonly<Record<GrowthChannel, string>> = {
  podcast: 'Podcast',
  search: 'Search',
  social: 'Social',
  friend: 'Friend or colleague',
  ad: 'Ad',
  newsletter: 'Newsletter',
  article: 'Article or review',
  other: 'Other',
};

const HEADINGS: Readonly<Record<GrowthSelfReportContext, string>> = {
  post_signup: 'Where did you hear about HushBox?',
  first_payment: 'Thanks for topping up. Where did you first hear about us?',
};

/** Whether the server says this account is owed the channel question. */
export function useChannelPromptEligibility(): boolean {
  const { data } = useAcquisitionSource();
  return data?.duePrompt != null;
}

/**
 * The channel question, as one card in the sidebar prompt slot.
 *
 * Eight chips and no text field, anywhere: the answers are read out of the
 * database by a model that holds write tools elsewhere, and no scrub separates
 * a genuine answer from an instruction written to look like one. What that
 * costs is the specific — "podcast" without which podcast — and it is the price
 * of the answers being data rather than input.
 *
 * Done confirms rather than a chip submitting on its own tap, so a mis-tap in a
 * narrow column is recoverable; Skip and the close control both record the skip
 * against the account, which is what lets the question be asked again at first
 * payment without asking twice on two devices.
 */
export function ChannelPrompt(): React.JSX.Element | null {
  const { data } = useAcquisitionSource();
  const { submit, isSubmitting } = useSelfReport();
  const [selected, setSelected] = useState<GrowthChannel | null>(null);
  const context = data?.duePrompt ?? null;

  if (context === null) return null;

  const skip = (): void => {
    submit({ action: 'skip', context });
  };

  return (
    <PromptCard
      className="relative"
      heading={HEADINGS[context]}
      body="Optional."
      primary={{
        label: 'Done',
        // No handler until a chip is chosen, which is what disables Done: the
        // card says "nothing to confirm yet" by having nothing to call.
        onPrimary:
          selected === null
            ? undefined
            : (): void => {
                submit({ action: 'answer', channel: selected, context });
              },
        isBusy: isSubmitting,
      }}
      secondary={{ label: 'Skip', onSecondary: skip, isBusy: isSubmitting }}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={skip}
        disabled={isSubmitting}
        aria-label="Dismiss this question"
        className="absolute top-1 right-1"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
      <div role="group" aria-label={HEADINGS[context]} className="flex flex-wrap gap-1.5">
        {GROWTH_CHANNELS.map((channel) => (
          <Button
            key={channel}
            type="button"
            size="sm"
            variant={selected === channel ? 'default' : 'outline'}
            aria-pressed={selected === channel}
            onClick={() => {
              setSelected(channel);
            }}
          >
            {CHANNEL_LABELS[channel]}
          </Button>
        ))}
      </div>
    </PromptCard>
  );
}

/**
 * The collapsed-rail stand-in. The rail is 48px wide, so the question cannot
 * live there; this keeps a labelled badge that expands the sidebar, where the
 * card is waiting. Expanding is navigation, never an answer.
 */
export function ChannelPromptRail(): React.JSX.Element | null {
  const eligible = useChannelPromptEligibility();
  const expandSidebar = useExpandSidebar();

  if (!eligible) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={expandSidebar}
      aria-label="Where did you hear about HushBox?"
      className="relative mt-2 shrink-0 self-center"
    >
      <HelpCircle className="h-4 w-4" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="bg-primary absolute top-1 right-1 h-1.5 w-1.5 rounded-full"
      />
    </Button>
  );
}
