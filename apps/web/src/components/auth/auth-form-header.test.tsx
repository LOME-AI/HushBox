import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthFormHeader } from './auth-form-header';

function sortedClasses(element: HTMLElement): string[] {
  return [...element.classList].toSorted((a, b) => a.localeCompare(b));
}

describe('AuthFormHeader', () => {
  it('renders its title as the page heading at level 1', () => {
    render(<AuthFormHeader title="Welcome back" subtitle="Sub" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });

  it('sets the title in the auth title role', () => {
    render(<AuthFormHeader title="Welcome back" subtitle="Sub" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-auth-title');
  });

  it('draws the title in ink by default', () => {
    render(<AuthFormHeader title="Welcome back" subtitle="Sub" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-foreground');
  });

  it('leaves the signal title to the heading rule, with no ink class', () => {
    render(<AuthFormHeader title="Two-Factor Authentication" subtitle="Sub" titleTone="signal" />);

    expect(screen.getByRole('heading', { level: 1 })).not.toHaveClass('text-foreground');
  });

  it('draws the tagline subtitle in brand red at the large size and medium weight', () => {
    render(<AuthFormHeader title="T" subtitle="Tagline" subtitleTone="tagline" />);

    expect(screen.getByText('Tagline')).toHaveClass('text-primary', 'text-lg', 'font-medium');
  });

  it('marks the tagline subtitle as a reading surface', () => {
    render(<AuthFormHeader title="T" subtitle="Tagline" subtitleTone="tagline" />);

    expect(screen.getByText('Tagline')).toHaveAttribute('data-reading');
  });

  it('uses the tagline tone when none is given', () => {
    render(<AuthFormHeader title="T" subtitle="Tagline" />);

    expect(screen.getByText('Tagline')).toHaveAttribute('data-reading');
  });

  it('draws the instruction subtitle in the tagline look', () => {
    render(<AuthFormHeader title="T" subtitle="Do this" subtitleTone="instruction" />);

    expect(sortedClasses(screen.getByText('Do this'))).toEqual([
      'font-medium',
      'text-lg',
      'text-primary',
    ]);
  });

  it('keeps the instruction subtitle off the reading face', () => {
    render(<AuthFormHeader title="T" subtitle="Do this" subtitleTone="instruction" />);

    expect(screen.getByText('Do this')).not.toHaveAttribute('data-reading');
  });

  it('draws the muted subtitle small in muted ink', () => {
    render(<AuthFormHeader title="T" subtitle="Quiet" subtitleTone="muted" />);

    expect(sortedClasses(screen.getByText('Quiet'))).toEqual(['text-muted-foreground', 'text-sm']);
  });

  it('draws the text subtitle at body size in muted ink', () => {
    render(<AuthFormHeader title="T" subtitle="Body" subtitleTone="text" />);

    expect(sortedClasses(screen.getByText('Body'))).toEqual(['text-base', 'text-muted-foreground']);
  });

  it('renders a subtitle that holds markup', () => {
    render(
      <AuthFormHeader
        title="T"
        subtitle={
          <>
            Sent to <span data-emphasis="">alice@example.com</span>.
          </>
        }
        subtitleTone="text"
      />
    );

    expect(screen.getByText('alice@example.com')).toHaveAttribute('data-emphasis');
  });

  it('breaks a title word too long for the column', () => {
    render(<AuthFormHeader title="No verification token" subtitle="Sub" />);

    expect(screen.getByRole('heading', { level: 1 }).closest('.wrap-break-word')).not.toBeNull();
  });

  it('breaks an address too long for the column in the subtitle', () => {
    render(
      <AuthFormHeader
        title="T"
        subtitle={
          <>
            Sent to <span>someone.with.a.rather.long.address@subdomain.example.com</span>.
          </>
        }
        subtitleTone="text"
      />
    );

    expect(
      screen
        .getByText('someone.with.a.rather.long.address@subdomain.example.com')
        .closest('.wrap-break-word')
    ).not.toBeNull();
  });

  it('lets the column holding the title and subtitle narrow below its longest word', () => {
    render(<AuthFormHeader title="Title" subtitle="Subtitle" />);

    const column = screen.getByRole('heading', { level: 1 }).closest('.min-w-0');
    expect(column?.contains(screen.getByText('Subtitle'))).toBe(true);
  });

  it('places the subtitle after the title', () => {
    render(<AuthFormHeader title="Title" subtitle="Subtitle" />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.compareDocumentPosition(screen.getByText('Subtitle'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
