import * as React from 'react';
import { cn } from '@hushbox/ui';
import { HamburgerButton } from '@/components/sidebar/hamburger-button';
import { useHeaderLayout } from '@/hooks/use-header-layout';

type HeaderRows = 1 | 2 | 3;

const gridStyles: Record<HeaderRows, React.CSSProperties> = {
  1: {
    gridTemplateAreas: '"left center right"',
    gridTemplateColumns: '1fr auto 1fr',
  },
  2: {
    gridTemplateAreas: '"center center" "left right"',
    gridTemplateColumns: 'auto 1fr',
  },
  3: {
    gridTemplateAreas: '"center" "left" "right"',
    gridTemplateColumns: '1fr',
  },
};

interface PageHeaderProps {
  /** Content for the left slot (after hamburger button and title) */
  left?: React.ReactNode;
  /** Content for the center slot */
  center?: React.ReactNode;
  /** Content for the right slot */
  right?: React.ReactNode;
  /** Title to display (uses brand color by default) */
  title?: string | undefined;
  /** Custom test ID for the header element */
  testId?: string;
  /** Custom test ID for the title element */
  titleTestId?: string;
  /** Whether title should use brand color (default: true) */
  brandTitle?: boolean;
}

export function PageHeader({
  left,
  center,
  right,
  title,
  testId = 'page-header',
  titleTestId = 'page-header-title',
  brandTitle = true,
}: Readonly<PageHeaderProps>): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const leftRef = React.useRef<HTMLDivElement>(null);
  const centerRef = React.useRef<HTMLDivElement>(null);
  const rightRef = React.useRef<HTMLDivElement>(null);

  const rows = useHeaderLayout(containerRef, leftRef, centerRef, rightRef);

  const leftAlone = rows === 3;
  const rightAlone = rows === 3;

  return (
    <header
      data-testid={testId}
      className="bg-background/95 supports-backdrop-blur:bg-background/60 sticky top-0 z-10 min-h-[53px] shrink-0 overflow-hidden border-b px-4 py-2 backdrop-blur"
    >
      <div
        ref={containerRef}
        data-testid={`${testId}-grid`}
        className="grid h-full content-center items-center gap-y-0.5"
        style={gridStyles[rows]}
      >
        {/* Left: hamburger (mobile) + title + custom left content */}
        <div
          ref={leftRef}
          className={cn(
            'inline-flex items-center gap-2',
            leftAlone ? 'justify-self-center' : 'justify-self-start'
          )}
          style={{ gridArea: 'left' }}
        >
          <HamburgerButton />
          {title && (
            <span
              data-testid={titleTestId}
              className={`hidden max-w-[200px] truncate text-sm font-medium md:block ${brandTitle ? 'text-primary' : ''}`}
              title={title}
            >
              {title}
            </span>
          )}
          {left}
        </div>

        {/* Center content */}
        <div
          ref={centerRef}
          className="inline-flex justify-self-center"
          style={{ gridArea: 'center' }}
        >
          {center}
        </div>

        {/* Right content */}
        <div
          ref={rightRef}
          className={cn(
            'inline-flex items-center gap-2',
            rightAlone ? 'justify-self-center' : 'justify-self-end'
          )}
          style={{ gridArea: 'right' }}
        >
          {right}
        </div>
      </div>
    </header>
  );
}
