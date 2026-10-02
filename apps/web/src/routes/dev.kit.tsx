import * as React from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { env } from '@/lib/platform/env';
import { useTheme } from '@/providers/theme-provider';
import { KIT_SECTIONS, type KitSection } from '@/components/dev/kit/kit-sections';

export const Route = createFileRoute('/dev/kit')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: KitPage,
});

function KitPage(): React.JSX.Element {
  const { mode } = useTheme();
  return (
    <main className="bg-background text-foreground min-h-full px-4 py-10 md:px-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-title-1">Component kit</h1>
        <p className="text-ui text-muted-foreground mt-2">
          Every primitive, drawn light beside dark.
        </p>
        {/* The dark variant matches anything under `html.dark`, so no island can be light
            while the app theme is dark. */}
        {mode === 'dark' && (
          <p className="text-ui text-foreground mt-4">
            The light island needs the light theme. Switch the app to light to review it.
          </p>
        )}
        {KIT_SECTIONS.length === 0 ? (
          <p className="text-ui text-muted-foreground mt-10 wrap-break-word">
            No sections yet. Each <code>&lt;name&gt;.section.tsx</code> file in{' '}
            <code>apps/web/src/components/dev/kit/</code> adds a section.
          </p>
        ) : (
          KIT_SECTIONS.map((section) => <KitSectionView key={section.title} section={section} />)
        )}
      </div>
    </main>
  );
}

function KitSectionView({ section }: Readonly<{ section: KitSection }>): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="mt-14">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-title-2">
          {section.title}
        </h2>
        <span className="text-caption text-muted-foreground font-mono">
          catalog part {section.part}
        </span>
      </div>
      <div className="border-border grid grid-cols-1 overflow-hidden rounded-lg border md:grid-cols-2">
        <KitIsland label="light" render={section.render} />
        <KitIsland
          label="dark"
          render={section.render}
          className="dark border-border border-t md:border-t-0 md:border-l"
        />
      </div>
    </section>
  );
}

interface KitIslandProps {
  label: 'light' | 'dark';
  render: KitSection['render'];
  className?: string;
}

function KitIsland({ label, render, className }: Readonly<KitIslandProps>): React.JSX.Element {
  const captionId = React.useId();
  return (
    <figure
      aria-labelledby={captionId}
      className={cn(
        'bg-background text-foreground flex min-w-0 flex-col gap-5 p-4 md:p-6',
        className
      )}
    >
      <figcaption id={captionId} className="text-caption text-muted-foreground font-mono">
        {label}
      </figcaption>
      {render()}
    </figure>
  );
}
