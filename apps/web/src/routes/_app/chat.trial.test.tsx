import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './chat.trial';

// ErrorBoundary stub renders a marker around its children so the test can assert
// the page is nested inside it (the route's whole job is that wrapping).
vi.mock('@/components/shared/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

// TrialChatPage drives live model/session state; the route only mounts it.
vi.mock('@/components/chat/page/trial-chat-page', () => ({
  TrialChatPage: (): React.JSX.Element => <div data-testid="trial-chat-page" />,
}));

describe('/_app/chat/trial route component', () => {
  it('renders the trial chat page inside an error boundary', () => {
    renderRoute(Route);

    const boundary = screen.getByTestId('error-boundary');
    expect(boundary).toBeInTheDocument();
    expect(boundary).toContainElement(screen.getByTestId('trial-chat-page'));
  });
});
