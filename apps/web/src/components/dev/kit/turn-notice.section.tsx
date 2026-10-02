import * as React from 'react';
import { TurnNoticeView } from '@/components/chat/notice/turn-notice-view';
import { turnNoticeForCode, type TurnNotice } from '@/lib/chat/turn-notice';
import { trialRefusalFor } from '@/lib/chat/trial-refusals';
import type { KitSection } from './kit-sections';

function Sample({
  name,
  children,
}: Readonly<{ name: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{name}</p>
      {children}
    </div>
  );
}

function trialLimit(): TurnNotice {
  const refusal = trialRefusalFor({ code: 'TRIAL_LIMIT_REACHED' });
  // The trial limit is always a trial refusal, so the reader's null never comes back for it.
  /* v8 ignore next */
  if (refusal === null) throw new Error('the trial limit is a trial refusal');
  return refusal.notice;
}

const regenerate = (): void => undefined;

function TurnNoticeSamples(): React.JSX.Element {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Sample name="a failed turn: the tile, Copy in the corner, Regenerate under the text">
        <TurnNoticeView
          placement="tile"
          notice={turnNoticeForCode('UNAVAILABLE')}
          onRegenerate={regenerate}
        />
      </Sample>
      <Sample name="rate limited: the wait in the action">
        <TurnNoticeView
          placement="tile"
          notice={turnNoticeForCode('RATE_LIMITED', { retryAfterSeconds: 12 })}
          onRegenerate={regenerate}
        />
      </Sample>
      <Sample name="a block that clears on its own: the hourglass">
        <TurnNoticeView
          placement="tile"
          notice={turnNoticeForCode('CONCURRENT_RUN')}
          onRegenerate={regenerate}
        />
      </Sample>
      <Sample name="the send gate refuses a re-run: Regenerate disabled, its reason in the tooltip">
        <TurnNoticeView
          placement="tile"
          notice={turnNoticeForCode('INSUFFICIENT_ADMISSION')}
          onRegenerate={regenerate}
          regenerateRefusal="send_cannot_start"
        />
      </Sample>
      <Sample name="the trial limit: a link in the action, no Regenerate">
        <TurnNoticeView placement="tile" notice={trialLimit()} onRegenerate={regenerate} />
      </Sample>
      <Sample name="a failed model's slot in a multi-model turn">
        <div className="max-w-sm">
          <TurnNoticeView
            placement="slot"
            notice={turnNoticeForCode('STREAM_ERROR')}
            onRegenerate={regenerate}
          />
        </div>
      </Sample>
    </div>
  );
}

const section: KitSection = {
  title: 'Turn notices',
  part: 5,
  render: () => <TurnNoticeSamples />,
};

export default section;
