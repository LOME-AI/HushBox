import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { act } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { BlogSearch } from './BlogSearch';

const ALL_TAGS: readonly string[] = ['ai-models', 'privacy', 'security'];
const TAG_COUNTS: Readonly<Record<string, number>> = {
  'ai-models': 2,
  privacy: 3,
  security: 2,
};

function mountBlogCards(cards: readonly { id: string; tags: readonly string[] }[]): HTMLDivElement {
  const container = document.createElement('div');
  for (const card of cards) {
    const article = document.createElement('a');
    article.dataset.blogCard = '';
    article.dataset.tags = card.tags.join(',');
    article.dataset.testid = `card-${card.id}`;
    article.textContent = card.id;
    container.append(article);
  }
  document.body.append(container);
  return container;
}

function setUrl(search: string): void {
  globalThis.history.replaceState({}, '', `/blog${search}`);
}

beforeEach(() => {
  document.body.innerHTML = '';
  globalThis.history.replaceState({}, '', '/blog');
});

describe('BlogSearch tag chips', () => {
  it('renders an "All" chip plus one chip per tag', () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByRole('link', { name: 'All' })).toBeInTheDocument();
    for (const tag of ALL_TAGS) {
      expect(screen.getByRole('link', { name: tag })).toBeInTheDocument();
    }
  });

  it('marks the "All" chip active when no ?tag is present', () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'privacy' })).not.toHaveAttribute(
      'aria-current',
      'true'
    );
  });
});

describe('BlogSearch URL ↔ state sync', () => {
  it('reads activeTag from ?tag query on mount and marks that chip active', async () => {
    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(await screen.findByRole('link', { name: 'privacy' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current', 'true');
  });

  it('updates the URL with ?tag= when a tag chip is clicked (without navigating)', async () => {
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    await user.click(screen.getByRole('link', { name: 'privacy' }));
    expect(globalThis.location.pathname + globalThis.location.search).toBe('/blog?tag=privacy');
  });

  it('clears the URL ?tag= when the "All" chip is clicked', async () => {
    setUrl('?tag=privacy');
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    await user.click(screen.getByRole('link', { name: 'All' }));
    expect(globalThis.location.pathname + globalThis.location.search).toBe('/blog');
  });

  it('updates state when popstate fires (back/forward navigation)', async () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');

    act(() => {
      globalThis.history.pushState({}, '', '/blog?tag=security');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByRole('link', { name: 'security' })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });
});

describe('BlogSearch DOM filtering of [data-blog-card]', () => {
  it('keeps all cards visible when no tag is active', () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
      { id: 'c', tags: ['privacy', 'security'] },
    ]);
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-c')).not.toHaveAttribute('hidden');
  });

  it('hides cards whose data-tags do not include the active tag', async () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
      { id: 'c', tags: ['privacy', 'security'] },
    ]);
    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await screen.findByRole('link', { name: 'privacy' });

    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).toHaveAttribute('hidden');
    expect(screen.getByTestId('card-c')).not.toHaveAttribute('hidden');
  });

  it('restores all cards when "All" is clicked after a filter', async () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
    ]);
    setUrl('?tag=privacy');
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await user.click(screen.getByRole('link', { name: 'All' }));

    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).not.toHaveAttribute('hidden');
  });

  it('toggles visibility when switching from one tag to another', async () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
    ]);
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await user.click(screen.getByRole('link', { name: 'privacy' }));
    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).toHaveAttribute('hidden');

    await user.click(screen.getByRole('link', { name: 'ai-models' }));
    expect(screen.getByTestId('card-a')).toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).not.toHaveAttribute('hidden');
  });
});

describe('BlogSearch "Posts tagged" line', () => {
  it('is absent when no tag is active', () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.queryByText(/Posts tagged:/)).not.toBeInTheDocument();
  });

  it('shows the active tag name and post count when filtered', async () => {
    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    const line = await screen.findByText(/Posts tagged:/);
    expect(line).toHaveTextContent('privacy');
    expect(line).toHaveTextContent('3 posts');
  });

  it('uses singular "post" for a tag with exactly one match', async () => {
    setUrl('?tag=solo');
    render(<BlogSearch allTags={['solo']} tagCounts={{ solo: 1 }} />);
    const line = await screen.findByText(/Posts tagged:/);
    expect(line).toHaveTextContent('1 post');
    expect(line).not.toHaveTextContent('1 posts');
  });
});
