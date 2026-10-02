import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TEST_IDS, noticeText, type MessageSegment, type NoticeReason } from '@hushbox/shared';
import { useCopyToClipboard } from '@hushbox/ui';
import { Button, IconButton } from '@hushbox/ui/button';
import { Check, CircleAlert, Copy, Hourglass, RefreshCw } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui/popover';
import { turnNoticeText, type TurnNotice } from '@/lib/chat/turn-notice';

interface TurnNoticeViewProps {
  placement: 'tile' | 'slot';
  notice: TurnNotice;
  onRegenerate?: () => void;
  regenerateRefusal?: NoticeReason;
}

function ActionText({
  segments,
}: Readonly<{ segments: readonly MessageSegment[] }>): React.JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.link === undefined ? (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ) : (
          // Its words stay together while they fit the column, and wrap inside it when not.
          <Link key={index} to={segment.link} className="inline-block max-w-full">
            {segment.text}
          </Link>
        )
      )}
    </>
  );
}

function CopyControl({ text }: Readonly<{ text: string }>): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          icon={copied ? Check : Copy}
          size="xs"
          aria-label={copied ? 'Copied' : 'Copy'}
          onClick={() => {
            void copy(text);
          }}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{copied ? 'Copied!' : 'Copy'}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A refused Regenerate stays focusable and hoverable (`aria-disabled`, never
 * `disabled`), so its reason is reachable in the tooltip and to a screen reader.
 */
function RefusedRegenerate({
  onRegenerate,
  refusal,
}: Readonly<{ onRegenerate: () => void; refusal: NoticeReason }>): React.JSX.Element {
  const id = React.useId();
  const text = noticeText(refusal);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" onClick={onRegenerate} aria-disabled aria-describedby={id}>
            <RefreshCw />
            Regenerate
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{text}</p>
        </TooltipContent>
      </Tooltip>
      <span id={id} className="sr-only">
        {text}
      </span>
    </>
  );
}

/** Regenerate when the notice offers it and the host can re-run; nothing otherwise. */
function regenerateAction(
  notice: TurnNotice,
  onRegenerate: (() => void) | undefined,
  refusal: NoticeReason | undefined
): React.ReactNode {
  if (notice.regenerate === 'withheld' || onRegenerate === undefined) return undefined;
  if (refusal !== undefined) {
    return <RefusedRegenerate onRegenerate={onRegenerate} refusal={refusal} />;
  }
  return (
    <Button variant="outline" onClick={onRegenerate}>
      <RefreshCw />
      Regenerate
    </Button>
  );
}

/**
 * A failed or refused turn: as the tile in the reply's place in the thread, or as
 * a failed model's slot under its nameplate. The text block holds the sentence
 * alone, so Copy, Regenerate and a refusal's description stay out of it.
 */
export function TurnNoticeView({
  placement,
  notice,
  onRegenerate,
  regenerateRefusal,
}: Readonly<TurnNoticeViewProps>): React.JSX.Element {
  const clearsOnItsOwn = notice.clears === 'on_its_own';
  const actions = regenerateAction(notice, onRegenerate, regenerateRefusal);
  return (
    <div
      data-severity={clearsOnItsOwn ? 'hourglass' : 'circle'}
      {...(placement === 'tile' && { 'data-testid': TEST_IDS.turnNoticeTile })}
    >
      <Notice
        tone="error"
        icon={clearsOnItsOwn ? Hourglass : CircleAlert}
        placement={placement}
        title={notice.cause}
        end={<CopyControl text={turnNoticeText(notice)} />}
        {...(notice.action.length > 0 && { children: <ActionText segments={notice.action} /> })}
        {...(actions !== undefined && { actions })}
        {...(placement === 'slot' && { textTestId: TEST_IDS.modelErrorMessage })}
      />
    </div>
  );
}
