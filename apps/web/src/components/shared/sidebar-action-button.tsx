import * as React from 'react';
import { cn } from '@hushbox/ui';

interface SidebarActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  collapsed?: boolean | undefined;
  testId?: string | undefined;
}

export function SidebarActionButton({
  icon,
  label,
  onClick,
  collapsed,
  testId,
}: Readonly<SidebarActionButtonProps>): React.JSX.Element {
  const slashButtonStyles = {
    clipPath: 'polygon(0 0, 100% 0, 95% 100%, 0 100%)',
  };

  if (collapsed) {
    return (
      <button
        onClick={onClick}
        aria-label={label}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        className={cn(
          'relative flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-lg',
          'from-primary to-secondary bg-gradient-to-r',
          'text-white transition-all hover:opacity-90 hover:shadow-md',
          'focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none'
        )}
        style={slashButtonStyles}
      >
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
            animation: 'shine 2s infinite',
          }}
        />
        <span className="relative z-10">{icon}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      aria-label={label}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={cn(
        'relative flex w-full cursor-pointer items-center justify-start gap-2 overflow-hidden rounded-lg px-3 py-2',
        'from-primary to-secondary bg-gradient-to-r',
        'font-medium text-white transition-all hover:opacity-90 hover:shadow-md',
        'focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none'
      )}
      style={slashButtonStyles}
    >
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
          animation: 'shine 3s infinite',
        }}
      />
      <span className="relative z-10">{icon}</span>
      <span className="relative z-10 whitespace-nowrap">{label}</span>
    </button>
  );
}
