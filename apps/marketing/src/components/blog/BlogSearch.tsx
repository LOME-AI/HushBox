import * as React from 'react';
import { Badge } from '@hushbox/ui';
import { Search } from 'lucide-react';

interface BlogIndexEntry {
  slug: string;
  title: string;
  description: string;
  tags: string[];
}

interface BlogSearchProps {
  allTags: string[];
  activeTag?: string;
}

function BlogSearch({ allTags, activeTag }: Readonly<BlogSearchProps>): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [index, setIndex] = React.useState<BlogIndexEntry[]>([]);
  const [results, setResults] = React.useState<BlogIndexEntry[]>([]);
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

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

  function handleSearch(value: string): void {
    setQuery(value);
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

  return (
    <div className="space-y-4">
      <div ref={containerRef} className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <Search className="text-foreground-muted h-4 w-4" />
        </div>
        <input
          type="text"
          placeholder="Search articles..."
          value={query}
          onChange={(e): void => {
            handleSearch(e.target.value);
          }}
          onFocus={(): void => {
            if (results.length > 0) setIsOpen(true);
          }}
          className="bg-background border-border-strong focus:border-brand-red w-full rounded-lg border-2 py-2 pr-3 pl-10 text-sm transition-colors outline-none"
        />

        {isOpen && (
          <div className="bg-card border-border absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg border-2 shadow-lg">
            {results.map((entry) => (
              <a
                key={entry.slug}
                href={`/blog/${entry.slug}`}
                className="hover:bg-background-subtle block px-4 py-3 transition-colors"
              >
                <div className="text-foreground text-sm font-medium">{entry.title}</div>
                <div className="text-foreground-muted mt-0.5 line-clamp-1 text-xs">
                  {entry.description}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <a href="/blog">
            <Badge
              variant={activeTag === undefined ? 'default' : 'outline'}
              className="cursor-pointer"
            >
              All
            </Badge>
          </a>
          {allTags.map((tag) => (
            <a key={tag} href={`/blog/tag/${tag}`}>
              <Badge variant={activeTag === tag ? 'default' : 'outline'} className="cursor-pointer">
                {tag}
              </Badge>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export { BlogSearch, type BlogIndexEntry };
