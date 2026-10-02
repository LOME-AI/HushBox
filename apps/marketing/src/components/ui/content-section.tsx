import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Heading } from '@hushbox/ui/type';

interface ContentSectionProps extends React.ComponentProps<'section'> {
  title: string;
}

function ContentSection({
  title,
  className,
  children,
  ...props
}: Readonly<ContentSectionProps>): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section
      data-slot="content-section"
      aria-labelledby={headingId}
      className={cn('flex scroll-mt-24 flex-col gap-4 wrap-break-word', className)}
      {...props}
    >
      <Heading level={2} variant="site-subhead" id={headingId}>
        {title}
      </Heading>
      {children}
    </section>
  );
}

export { ContentSection };
