import * as React from 'react';
import { Search } from 'lucide-react';
import { Badge } from '@hushbox/ui';

interface BlogIndexEntry {
  slug: string;
  title: string;
  description: string;
  tags: string[];
}

interface BlogSearchProps {
  allTags: string[];
  tagCounts: Record<string, number>;
}

function readTagFromLocation(): string | null {
  const params = new URLSearchParams(globalThis.location.search);
  const tag = params.get('tag');
  return tag === null || tag === '' ? null : tag;
}

function tagUrl(tag: string | null): string {
  if (tag === null) return '/blog';
  return `/blog?${new URLSearchParams({ tag }).toString()}`;
}

function resultCountLabel(query: string, count: number): string {
  if (query.trim() === '') return '';
  const noun = count === 1 ? 'result' : 'results';
  return `${String(count)} ${noun}`;
}

interface KeyHandlerArgs {
  results: BlogIndexEntry[];
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}

const KEY_HANDLERS: Partial<Record<string, (args: KeyHandlerArgs) => void>> = {
  ArrowDown: ({ results, setActiveIndex }) => {
    setActiveIndex((current) => (current + 1) % results.length);
  },
  ArrowUp: ({ results, setActiveIndex }) => {
    setActiveIndex((current) => (current <= 0 ? results.length - 1 : current - 1));
  },
  Enter: ({ results, activeIndex }) => {
    if (activeIndex < 0) return;
    globalThis.location.assign(`/blog/${results[activeIndex].slug}`);
  },
};

function BlogSearch({ allTags, tagCounts }: Readonly<BlogSearchProps>): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [index, setIndex] = React.useState<BlogIndexEntry[]>([]);
  const [results, setResults] = React.useState<BlogIndexEntry[]>([]);
  const [isOpen, setIsOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [activeTag, setActiveTag] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listboxId = React.useId();
  const optionId = (slug: string): string => `${listboxId}-${slug}`;

  React.useEffect(() => {
    async function loadIndex(): Promise<void> {
      try {
        const response = await fetch('/blog-index.json');
        const data = (await response.json()) as BlogIndexEntry[];
        setIndex(data);
      } catch {
        // Search degrades gracefully with an empty index
      }
    }
    void loadIndex();
  }, []);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return (): void => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  React.useEffect(() => {
    setActiveTag(readTagFromLocation());
    function handlePopState(): void {
      setActiveTag(readTagFromLocation());
    }
    globalThis.addEventListener('popstate', handlePopState);
    return (): void => {
      globalThis.removeEventListener('popstate', handlePopState);
    };
  }, []);

  React.useEffect(() => {
    const cards = document.querySelectorAll<HTMLElement>('[data-blog-card]');
    for (const card of cards) {
      const tags = (card.dataset.tags ?? '').split(',').filter(Boolean);
      const shouldShow = activeTag === null || tags.includes(activeTag);
      card.hidden = !shouldShow;
    }
  }, [activeTag]);

  function handleSearch(value: string): void {
    setQuery(value);
    setActiveIndex(-1);
    if (value.trim() === '') {
      setResults([]);
      setIsOpen(false);
      return;
    }

    const lower = value.toLowerCase();
    const matched = index.filter(
      (entry) =>
        entry.title.toLowerCase().includes(lower) ||
        entry.description.toLowerCase().includes(lower) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(lower))
    );
    setResults(matched);
    setIsOpen(matched.length > 0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!isOpen || results.length === 0) return;

    const handler = KEY_HANDLERS[event.key];
    if (handler === undefined) return;
    event.preventDefault();
    handler({ results, activeIndex, setActiveIndex });
  }

  function handleTagClick(event: React.MouseEvent<HTMLAnchorElement>, tag: string | null): void {
    event.preventDefault();
    setActiveTag(tag);
    globalThis.history.pushState({}, '', tagUrl(tag));
  }

  const activeCount = activeTag === null ? 0 : (tagCounts[activeTag] ?? 0);

  return (
    <div className="space-y-4">
      <div ref={containerRef} className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <Search className="text-muted-foreground h-4 w-4" />
        </div>
        <input
          type="text"
          role="combobox"
          aria-label="Search articles"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? optionId(results[activeIndex].slug) : undefined}
          placeholder="Search articles..."
          value={query}
          onChange={(e): void => {
            handleSearch(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={(): void => {
            if (results.length > 0) setIsOpen(true);
          }}
          className="bg-background border-border-strong focus:border-brand-red w-full rounded-lg border-2 py-2 pr-3 pl-10 text-sm transition-colors outline-none"
        />

        {isOpen && (
          <div
            role="listbox"
            id={listboxId}
            aria-label="Search results"
            className="bg-card border-border absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg border-2 shadow-lg"
          >
            {results.map((entry, optionIndex) => (
              <a
                key={entry.slug}
                id={optionId(entry.slug)}
                role="option"
                aria-selected={optionIndex === activeIndex}
                href={`/blog/${entry.slug}`}
                className="hover:bg-background-subtle aria-selected:bg-background-subtle block px-4 py-3 transition-colors"
              >
                <div className="text-foreground text-sm font-medium">{entry.title}</div>
                <div className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
                  {entry.description}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {resultCountLabel(query, results.length)}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <a
            href={tagUrl(null)}
            aria-current={activeTag === null ? 'true' : undefined}
            onClick={(e): void => {
              handleTagClick(e, null);
            }}
          >
            <Badge variant={activeTag === null ? 'default' : 'outline'} className="cursor-pointer">
              All
            </Badge>
          </a>
          {allTags.map((tag) => (
            <a
              key={tag}
              href={tagUrl(tag)}
              aria-current={activeTag === tag ? 'true' : undefined}
              onClick={(e): void => {
                handleTagClick(e, tag);
              }}
            >
              <Badge variant={activeTag === tag ? 'default' : 'outline'} className="cursor-pointer">
                {tag}
              </Badge>
            </a>
          ))}
        </div>
      )}

      {activeTag !== null && (
        <p className="text-muted-foreground text-center text-sm">
          Posts tagged: <span className="text-foreground font-semibold">{activeTag}</span>
          {' · '}
          {activeCount} {activeCount === 1 ? 'post' : 'posts'}
        </p>
      )}
    </div>
  );
}

export { BlogSearch, type BlogIndexEntry };
