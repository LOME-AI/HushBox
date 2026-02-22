import * as React from 'react';
import { cn } from '../../lib/utilities';

interface NavSection {
  id: string;
  label: string;
}

interface SectionNavProps extends React.ComponentProps<'nav'> {
  sections: NavSection[];
}

function SectionNav({
  sections,
  className,
  ...props
}: Readonly<SectionNavProps>): React.JSX.Element {
  return (
    <nav data-slot="section-nav" className={cn('flex gap-4', className)} {...props}>
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="text-muted-foreground hover:text-foreground cursor-pointer text-sm underline-offset-4 transition-colors hover:underline"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

export { SectionNav, type SectionNavProps, type NavSection };
