import * as React from 'react';
import { HamburgerButton } from '@/components/sidebar/hamburger-button';

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
}: PageHeaderProps): React.JSX.Element {
  return (
    <header
      data-testid={testId}
      className="bg-background/95 supports-backdrop-blur:bg-background/60 sticky top-0 z-10 flex h-[53px] shrink-0 items-center justify-center border-b px-4 backdrop-blur"
    >
      {/* Left side with hamburger (mobile only) and title */}
      <div className="flex flex-1 items-center justify-start gap-2">
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
      {center}

      {/* Right side */}
      <div className="flex flex-1 justify-end">{right}</div>
    </header>
  );
}
