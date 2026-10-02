import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TopicTag, TopicTagRow } from './TopicTag';

function classesOf(element: Element): string[] {
  return [...element.classList];
}

function lineOf(landmark: HTMLElement): Element {
  const line = landmark.firstElementChild;
  if (line === null) throw new Error('the topic row renders no line inside its landmark');
  return line;
}

describe('TopicTag', () => {
  it('links to its topic by the href given', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(screen.getByRole('link', { name: 'privacy' })).toHaveAttribute(
      'href',
      '/blog?tag=privacy'
    );
  });

  it('carries no current state unless it is the current topic', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(screen.getByRole('link', { name: 'privacy' })).not.toHaveAttribute('aria-current');
  });

  it('marks the current topic for assistive technology', () => {
    render(
      <TopicTag href="/blog" current>
        All
      </TopicTag>
    );
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
  });

  it('draws an idle topic as an outline pill in the ink colour', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(classesOf(screen.getByRole('link'))).toEqual(
      expect.arrayContaining([
        'rounded-full',
        'border',
        'border-border',
        'bg-transparent',
        'text-foreground',
        'hover:bg-accent',
      ])
    );
  });

  it('draws the current topic white on Signal Red with no visible outline', () => {
    render(
      <TopicTag href="/blog" current>
        All
      </TopicTag>
    );
    const classes = classesOf(screen.getByRole('link'));
    expect(classes).toEqual(
      expect.arrayContaining(['border-transparent', 'bg-primary', 'text-primary-foreground'])
    );
    expect(classes).not.toContain('border-border');
    expect(classes).not.toContain('hover:bg-accent');
  });

  it('sets its label in small medium-weight sans type on a one-line box', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(classesOf(screen.getByRole('link'))).toEqual(
      expect.arrayContaining([
        'font-sans',
        'text-xs',
        'leading-4',
        'font-medium',
        'whitespace-nowrap',
        'px-2',
        'py-0.5',
        'no-underline',
      ])
    );
  });

  it('eases only its ink, so its fill, border and focus outline change at once', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(
      classesOf(screen.getByRole('link')).filter((token) => token.startsWith('transition'))
    ).toEqual(['transition-[color]']);
  });

  it('keeps the current topic distinct under forced colours', () => {
    render(
      <TopicTag href="/blog" current>
        All
      </TopicTag>
    );
    expect(classesOf(screen.getByRole('link'))).toEqual(
      expect.arrayContaining([
        'forced-colors:forced-color-adjust-none',
        'forced-colors:border-[color:Highlight]',
        'forced-colors:bg-[color:Highlight]',
        'forced-colors:text-[color:HighlightText]',
      ])
    );
  });

  it('leaves an idle topic to the forced palette', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(
      classesOf(screen.getByRole('link')).filter((token) => token.startsWith('forced-colors:'))
    ).toEqual([]);
  });

  it('keeps its own width inside a row that does not wrap', () => {
    render(<TopicTag href="/blog?tag=privacy">privacy</TopicTag>);
    expect(classesOf(screen.getByRole('link'))).toContain('flex-none');
  });

  it('hands its click to the handler given', async () => {
    const onClick = vi.fn((event: React.MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
    });
    const user = userEvent.setup();
    render(
      <TopicTag href="/blog?tag=privacy" onClick={onClick}>
        privacy
      </TopicTag>
    );
    await user.click(screen.getByRole('link', { name: 'privacy' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('TopicTagRow', () => {
  it('is a navigation landmark named by its label', () => {
    render(
      <TopicTagRow label="Topics">
        <TopicTag href="/blog">All</TopicTag>
      </TopicTagRow>
    );
    expect(screen.getByRole('navigation', { name: 'Topics' })).toContainElement(
      screen.getByRole('link', { name: 'All' })
    );
  });

  it('wraps its tags half a rem apart from the 768 band up', () => {
    render(<TopicTagRow label="Topics">{null}</TopicTagRow>);
    expect(classesOf(lineOf(screen.getByRole('navigation')))).toEqual(
      expect.arrayContaining(['flex', 'flex-wrap', 'gap-2'])
    );
  });

  it('keeps one line on phones and scrolls it sideways', () => {
    render(<TopicTagRow label="Topics">{null}</TopicTagRow>);
    expect(classesOf(lineOf(screen.getByRole('navigation')))).toEqual(
      expect.arrayContaining([
        'max-md:flex-nowrap',
        'max-md:overflow-x-auto',
        'max-md:overscroll-x-contain',
        'max-md:[scrollbar-width:none]',
        'max-md:[&::-webkit-scrollbar]:hidden',
      ])
    );
  });

  it('runs to the screen edge on phones, its first tag still on the page gutter', () => {
    render(<TopicTagRow label="Topics">{null}</TopicTagRow>);
    expect(classesOf(lineOf(screen.getByRole('navigation')))).toEqual(
      expect.arrayContaining(['max-md:-mx-6', 'max-md:px-6'])
    );
  });

  it('fades both edges of the scrolling line on phones', () => {
    render(<TopicTagRow label="Topics">{null}</TopicTagRow>);
    expect(classesOf(lineOf(screen.getByRole('navigation')))).toContain(
      'max-md:[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-2.5rem),transparent)]'
    );
  });

  it('leaves room inside the scrolling line for a focused tag outline without moving the tags', () => {
    render(<TopicTagRow label="Topics">{null}</TopicTagRow>);
    expect(classesOf(lineOf(screen.getByRole('navigation')))).toEqual(
      expect.arrayContaining(['max-md:-my-1', 'max-md:py-1'])
    );
  });

  it('contains the outline room inside the landmark, so its parent alone spaces the row', () => {
    render(<TopicTagRow label="Topics">{null}</TopicTagRow>);
    const landmark = screen.getByRole('navigation');
    expect(classesOf(landmark)).toEqual(['flow-root']);
  });
});
