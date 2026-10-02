import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { friendlyErrorMessage } from '@hushbox/shared';
import { NewsletterUnsubscribed } from './NewsletterUnsubscribed';
import * as hookModule from './use-token-action';
import type { TokenActionState } from './use-token-action';

function mockAction(state: TokenActionState): void {
  vi.spyOn(hookModule, 'useTokenAction').mockReturnValue(state);
}

describe('NewsletterUnsubscribed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('unsubscribes against /newsletter/unsubscribe', () => {
    const spy = vi
      .spyOn(hookModule, 'useTokenAction')
      .mockReturnValue({ status: 'pending', code: null });
    render(<NewsletterUnsubscribed />);
    expect(spy).toHaveBeenCalledWith('/newsletter/unsubscribe');
  });

  it('shows a quiet status while pending', () => {
    mockAction({ status: 'pending', code: null });
    render(<NewsletterUnsubscribed />);
    expect(screen.getByRole('status')).toHaveTextContent('Unsubscribing');
  });

  it('confirms the unsubscribe plainly on success', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    expect(screen.getByRole('heading', { name: "You're unsubscribed." })).toBeInTheDocument();
    expect(screen.getByText('No further emails.')).toBeInTheDocument();
  });

  it('sets the success headline as the level-one page title in the site title role', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    const heading = screen.getByRole('heading', { level: 1, name: "You're unsubscribed." });
    expect(heading).toHaveClass('text-site-title');
  });

  it('gives the success headline no width step of its own', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    const heading = screen.getByRole('heading', { name: "You're unsubscribed." });
    expect(heading.className).not.toMatch(/\b(?:sm|md|lg|xl):/);
  });

  // Under the widget's largest text a word can be wider than a phone; the block breaks it
  // rather than widening the page, and words that fit wrap as before.
  it('lets the success block break a word wider than the screen', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    const heading = screen.getByRole('heading', { name: "You're unsubscribed." });
    expect(heading.parentElement).toHaveClass('wrap-anywhere');
  });

  it('offers a way back in on success without pressure', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    expect(screen.getByRole('link', { name: 'Changed your mind? Sign up again' })).toHaveAttribute(
      'href',
      '/newsletter'
    );
  });

  it('shows the friendly error and a signup link for an invalid token', () => {
    mockAction({ status: 'error', code: 'NEWSLETTER_UNSUBSCRIBE_INVALID' });
    render(<NewsletterUnsubscribed />);
    expect(
      screen.getByText(friendlyErrorMessage('NEWSLETTER_UNSUBSCRIBE_INVALID'))
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the newsletter page' })).toHaveAttribute(
      'href',
      '/newsletter'
    );
  });

  it('treats a missing token as an invalid unsubscribe link', () => {
    mockAction({ status: 'missing', code: null });
    render(<NewsletterUnsubscribed />);
    expect(
      screen.getByText(friendlyErrorMessage('NEWSLETTER_UNSUBSCRIBE_INVALID'))
    ).toBeInTheDocument();
  });
});
