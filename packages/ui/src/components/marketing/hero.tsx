import * as React from 'react';
import { cn } from '../../lib/utilities';

interface HeroProps extends React.ComponentProps<'section'> {
  title: string;
  subtitle?: string;
  size?: 'full' | 'compact';
}

function Hero({
  title,
  subtitle,
  size = 'full',
  className,
  children,
  ...props
}: Readonly<HeroProps>): React.JSX.Element {
  return (
    <section
      data-slot="hero"
      data-size={size}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'full' ? 'min-h-screen' : 'py-16',
        className
      )}
      {...props}
    >
      <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
      {subtitle !== undefined && (
        <p data-slot="hero-subtitle" className="text-muted-foreground mt-4 text-lg">
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

export { Hero, type HeroProps };
