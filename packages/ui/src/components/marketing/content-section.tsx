import * as React from 'react';
import { cn } from '../../lib/utilities';

interface ContentSectionProps extends React.ComponentProps<'section'> {
  title: string;
}

function ContentSection({
  title,
  className,
  children,
  ...props
}: Readonly<ContentSectionProps>): React.JSX.Element {
  return (
    <section data-slot="content-section" className={cn('space-y-4', className)} {...props}>
      <h2 className="text-xl font-semibold">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

export { ContentSection, type ContentSectionProps };
