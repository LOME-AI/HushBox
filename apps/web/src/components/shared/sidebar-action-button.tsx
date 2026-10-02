import * as React from 'react';
import { cn } from '@hushbox/ui';
import { SLANTED_CLIP_PATH } from './slanted-clip-path';

interface SidebarActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: (event: React.MouseEvent) => void;
  href?: string | undefined;
  collapsed?: boolean | undefined;
  testId?: string | undefined;
}

export function SidebarActionButton({
  icon,
  label,
  onClick,
  href,
  collapsed,
  testId,
}: Readonly<SidebarActionButtonProps>): React.JSX.Element {
  const slashButtonStyles = {
    clipPath: SLANTED_CLIP_PATH,
  };

  const className = collapsed
    ? cn(
        'relative flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-lg',
        'bg-primary',
        'text-white transition-all hover:opacity-90 hover:shadow-md',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-hidden'
      )
    : cn(
        'relative flex w-full cursor-pointer items-center justify-start gap-2 overflow-hidden rounded-lg px-3 py-2',
        'bg-primary',
        'font-medium text-white transition-all hover:opacity-90 hover:shadow-md',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-hidden'
      );

  const content = (
    <>
      <div
        className={cn(
          'pointer-events-none absolute inset-0',
          collapsed ? 'sidebar-sheen-collapsed' : 'sidebar-sheen'
        )}
        aria-hidden="true"
        style={{
          animation: collapsed ? 'shine 2s infinite' : 'shine 3s infinite',
        }}
      />
      <span className="relative z-10">{icon}</span>
      {!collapsed && <span className="relative z-10 whitespace-nowrap">{label}</span>}
    </>
  );

  const sharedProps = {
    onClick,
    'aria-label': label,
    className,
    style: slashButtonStyles,
    ...(testId === undefined ? {} : { 'data-testid': testId }),
  };

  // An anchor (not a button) lets native middle-click and cmd/ctrl-click open
  // the destination in a new tab; a button can't trigger that browser behavior.
  if (href !== undefined) {
    return (
      <a href={href} {...sharedProps}>
        {content}
      </a>
    );
  }

  return <button {...sharedProps}>{content}</button>;
}
