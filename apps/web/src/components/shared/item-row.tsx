import * as React from 'react';
import { cn } from '@hushbox/ui';
import { ThreeDotsMenu } from '@/components/shared/three-dots-menu';

interface ItemRowProps {
  children: React.ReactNode;
  menuContent: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  menuProps?: {
    align?: 'start' | 'end';
    className?: string;
    'data-testid'?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  };
  showMenu?: boolean;
}

export function ItemRow({
  children,
  menuContent,
  className,
  menuProps,
  showMenu = true,
  ...props
}: Readonly<ItemRowProps>): React.JSX.Element {
  return (
    <div
      data-testid={props['data-testid']}
      className={cn(
        'group relative flex items-center overflow-hidden rounded-md transition-colors',
        className
      )}
    >
      {children}
      {showMenu && <ThreeDotsMenu {...menuProps}>{menuContent}</ThreeDotsMenu>}
    </div>
  );
}
