import { cn } from '@hushbox/ui';
import type * as React from 'react';

interface TopicTagProps {
  href: string;
  current?: boolean;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  children: React.ReactNode;
}

interface TopicTagRowProps {
  label: string;
  children: React.ReactNode;
}

const TAG_FRAME =
  'inline-flex flex-none items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-xs leading-4 font-medium whitespace-nowrap no-underline transition-[color]';

const TAG_IDLE = 'border-border bg-transparent text-foreground hover:bg-accent';

/** Forced colours flatten the red fill, so the current topic takes the system highlight there. */
const TAG_CURRENT =
  'border-transparent bg-primary text-primary-foreground forced-colors:forced-color-adjust-none forced-colors:border-[color:Highlight] forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText]';

/**
 * Below 768 the row keeps one line that scrolls sideways out to the screen edge, bleeding
 * through the page's 1.5rem gutter so the first tag still sits on it. The vertical padding,
 * cancelled by an equal negative margin, keeps a focused tag's outline inside the scroller,
 * which clips on both axes once it scrolls on one. The landmark is a flow root so that negative
 * margin stays inside it: on the landmark itself it would override the parent's sibling spacing.
 */
const ROW_PHONE =
  'max-md:-mx-6 max-md:-my-1 max-md:flex-nowrap max-md:overflow-x-auto max-md:overscroll-x-contain max-md:px-6 max-md:py-1 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden max-md:[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-2.5rem),transparent)]';

/** A topic filter: a small outline pill linking to its topic, Signal Red when current. */
function TopicTag({
  href,
  current = false,
  onClick,
  children,
}: Readonly<TopicTagProps>): React.JSX.Element {
  return (
    <a
      href={href}
      aria-current={current ? 'true' : undefined}
      onClick={onClick}
      className={cn(TAG_FRAME, current ? TAG_CURRENT : TAG_IDLE)}
    >
      {children}
    </a>
  );
}

/** The row of topic filters, a navigation landmark named by `label`. */
function TopicTagRow({ label, children }: Readonly<TopicTagRowProps>): React.JSX.Element {
  return (
    <nav aria-label={label} className="flow-root">
      <div className={cn('flex flex-wrap gap-2', ROW_PHONE)}>{children}</div>
    </nav>
  );
}

export { TopicTag, TopicTagRow };
