import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@lome-chat/ui';

interface LogoProps {
  asLink?: boolean;
  to?: string;
  className?: string;
}

export function Logo({ asLink = false, to = '/chat', className }: LogoProps): React.JSX.Element {
  const content = (
    <div data-testid="logo" className={cn('flex items-center gap-2', className)}>
      <img
        src="/assets/images/FlowerHD.png"
        alt="LOME Logo"
        className="h-6 w-6 shrink-0 -translate-y-0.5 object-contain"
      />
      <span className="text-primary text-lg font-bold">LOME</span>
    </div>
  );

  if (asLink) {
    return (
      <Link to={to} aria-label="LOME - Go to chat">
        {content}
      </Link>
    );
  }

  return content;
}
