import * as React from 'react';
import { isNative } from '@/capacitor/platform';
import { openExternalPage } from '@/capacitor/browser';

interface ExternalPageLinkProps extends Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'target' | 'rel'
> {
  /** Marketing site path, e.g. '/privacy' */
  path: string;
  children: React.ReactNode;
}

export const ExternalPageLink = React.forwardRef<HTMLAnchorElement, ExternalPageLinkProps>(
  ({ path, children, onClick, ...rest }, ref) => {
    if (isNative()) {
      return (
        <a
          ref={ref}
          role="link"
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault();
            onClick?.(e);
            void openExternalPage(path);
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    return (
      <a
        ref={ref}
        href={path}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        {...rest}
      >
        {children}
      </a>
    );
  }
);

ExternalPageLink.displayName = 'ExternalPageLink';
