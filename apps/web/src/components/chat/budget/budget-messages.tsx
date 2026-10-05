import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { Collapse, Presence } from '@hushbox/ui/motion';
import { Notice, NoticeDismiss, NoticeStack } from '@hushbox/ui/notice';
import { NOTICE_SHAPES, composerNoticeShape } from '@/lib/chat/notice-shape';
import type { BudgetError } from '@hushbox/shared';

interface BudgetMessagesProps {
  /** The composer's notices, in the order they show. */
  errors: readonly BudgetError[];
  className?: string;
}

/**
 * Plain text whose last two words wrap as one, so the notice's last line never holds a word
 * alone. `text-wrap: pretty` alone still leaves one at a phone's width: in Chromium at large
 * text sizes, and in Firefox at the default size too.
 */
function WithJoinedTail({ text }: Readonly<{ text: string }>): React.JSX.Element {
  const tail = /\S+\s+\S+\s*$/.exec(text);
  if (tail === null) return <>{text}</>;
  return (
    <>
      {text.slice(0, tail.index)}
      <span className="whitespace-nowrap">{tail[0]}</span>
    </>
  );
}

function MessageText({ error }: Readonly<{ error: BudgetError }>): React.JSX.Element {
  const segments =
    error.segments === undefined || error.segments.length === 0
      ? [{ text: error.message }]
      : error.segments;
  const last = segments.length - 1;
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.link !== undefined) {
          return (
            <Link key={index} to={segment.link}>
              {segment.text}
            </Link>
          );
        }
        return index === last ? (
          <WithJoinedTail key={index} text={segment.text} />
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        );
      })}
    </>
  );
}

function BudgetNotice({
  error,
  onDismiss,
}: Readonly<{
  error: BudgetError;
  onDismiss: (id: BudgetError['id']) => void;
}>): React.JSX.Element {
  const shape = composerNoticeShape(error);
  const { tone, icon } = NOTICE_SHAPES[shape];
  return (
    <div data-severity={shape}>
      <Notice
        tone={tone}
        icon={icon}
        placement="composer"
        data-testid={TEST_ID_BUILDERS.budgetMessage(error.id)}
        {...(error.type !== 'error' && {
          end: (
            <NoticeDismiss
              onDismiss={() => {
                onDismiss(error.id);
              }}
              data-testid={TEST_ID_BUILDERS.budgetDismiss(error.id)}
            />
          ),
        })}
      >
        <MessageText error={error} />
      </Notice>
    </div>
  );
}

/**
 * The composer's notice stack. A dismissed notice stays hidden until it leaves the list,
 * so the same condition arising again shows again.
 */
export function BudgetMessages({
  errors,
  className,
}: Readonly<BudgetMessagesProps>): React.JSX.Element {
  const [dismissedIds, setDismissedIds] = React.useState<ReadonlySet<string>>(new Set());
  const previousErrorIds = React.useRef<ReadonlySet<string>>(new Set());

  React.useEffect(() => {
    const currentIds = new Set<string>(errors.map((e) => e.id));
    const removedIds = [...previousErrorIds.current].filter((id) => !currentIds.has(id));
    if (removedIds.length > 0) {
      setDismissedIds((previous) => {
        const next = new Set(previous);
        for (const id of removedIds) {
          next.delete(id);
        }
        return next.size === previous.size ? previous : next;
      });
    }
    previousErrorIds.current = currentIds;
  }, [errors]);

  if (errors.length === 0) {
    return <></>;
  }

  const visibleErrors = errors.filter((e) => !dismissedIds.has(e.id));

  function handleDismiss(id: string): void {
    setDismissedIds((previous) => new Set(previous).add(id));
  }

  return (
    <div
      data-testid={TEST_IDS.budgetMessages}
      className={className}
      role="region"
      aria-live="polite"
    >
      {/* A dismiss's touch target reaches past its notice's edge. The padding keeps it inside
          the height tween's clip at the stack's top and bottom; the margin gives the room back. */}
      <div className="-my-0.5">
        <Collapse open={visibleErrors.length > 0}>
          <div className="py-0.5">
            <NoticeStack>
              <Presence>
                {visibleErrors.map((error) => (
                  <BudgetNotice key={error.id} error={error} onDismiss={handleDismiss} />
                ))}
              </Presence>
            </NoticeStack>
          </div>
        </Collapse>
      </div>
    </div>
  );
}
