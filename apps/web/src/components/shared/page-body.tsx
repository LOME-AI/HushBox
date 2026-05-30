import * as React from 'react';
import { cn } from '@hushbox/ui';

interface PageBodyProps {
  children: React.ReactNode;
  /** Optional Tailwind classes appended to the inner content wrapper (e.g. `space-y-6`). */
  className?: string;
  /** Optional `data-testid` on the outer scroll container. Defaults to `'page-body'`. */
  testId?: string;
}

/**
 * Pairs with `PageHeader` to form a page body. The OUTER div is the full-width
 * scroll container — wheel and touch scroll work anywhere in the body area,
 * including the empty side margins. The INNER div constrains visual width
 * (`container mx-auto max-w-4xl p-4`). Together they preserve the existing
 * content shape while making the entire body scrollable.
 *
 * Routes should compose `<PageHeader />` + `<PageBody>...</PageBody>` instead
 * of hand-writing the `container mx-auto max-w-4xl flex-1 overflow-y-auto`
 * pattern — that combination puts the scroll container on the content-width
 * div, so scroll only activates over the centered content.
 */
export function PageBody({
  children,
  className,
  testId = 'page-body',
}: Readonly<PageBodyProps>): React.JSX.Element {
  return (
    <div data-testid={testId} className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('container mx-auto max-w-4xl p-4', className)}>{children}</div>
    </div>
  );
}
