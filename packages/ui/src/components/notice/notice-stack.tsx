import type * as React from 'react';

/** The composer's notices, one above another, 0.5rem apart. */
function NoticeStack({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="flex flex-col gap-2">{children}</div>;
}

export { NoticeStack };
