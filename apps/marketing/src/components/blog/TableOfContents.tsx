import * as React from 'react';
import { cn } from '@hushbox/ui';

interface Heading {
  depth: number;
  slug: string;
  text: string;
}

interface TableOfContentsProps {
  headings: Heading[];
}

function TableOfContents({ headings }: Readonly<TableOfContentsProps>): React.JSX.Element | null {
  const [activeId, setActiveId] = React.useState<string>('');

  const tocHeadings = React.useMemo(
    () => headings.filter((h) => h.depth === 2 || h.depth === 3),
    [headings]
  );

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-96px 0px -70% 0px' }
    );

    for (const heading of tocHeadings) {
      const el = document.querySelector(`#${CSS.escape(heading.slug)}`);
      if (el) observer.observe(el);
    }

    return (): void => {
      observer.disconnect();
    };
  }, [tocHeadings]);

  React.useEffect(() => {
    if (tocHeadings.length === 0) return;

    const lastSlug = tocHeadings.at(-1)?.slug;

    function handleScroll(): void {
      const atBottom =
        globalThis.innerHeight + globalThis.scrollY >= document.body.offsetHeight - 10;
      if (atBottom && lastSlug) {
        setActiveId(lastSlug);
      }
    }

    globalThis.addEventListener('scroll', handleScroll, { passive: true });
    return (): void => {
      globalThis.removeEventListener('scroll', handleScroll);
    };
  }, [tocHeadings]);

  function handleClick(slug: string): void {
    setActiveId(slug);
  }

  if (tocHeadings.length === 0) return null;

  return (
    <nav aria-label="Table of contents">
      <h2 className="text-foreground text-sm font-semibold">On this page</h2>
      <ul className="mt-3 space-y-2">
        {tocHeadings.map((heading) => (
          <li key={heading.slug}>
            <a
              href={`#${heading.slug}`}
              onClick={(): void => {
                handleClick(heading.slug);
              }}
              className={cn(
                'block text-sm transition-colors',
                heading.depth === 3 && 'pl-3',
                activeId === heading.slug
                  ? 'text-brand-red border-brand-red border-l-2 pl-2'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export { TableOfContents, type Heading };
