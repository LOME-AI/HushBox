import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import * as React from 'react';

import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { TtsStoppedNotice } from './tts-stopped-notice';

function renderInRouter(ui: React.ReactNode): ReturnType<typeof render> {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{ui}</>,
  });
  const accessibilityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accessibility',
    component: () => <div>accessibility page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, accessibilityRoute]),
  });
  return render(<RouterProvider router={router} />);
}

describe('TtsStoppedNotice', () => {
  beforeEach(() => {
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
    });
  });

  it('renders nothing when the message id is not in stoppedStreamIds', () => {
    const { container } = renderInRouter(<TtsStoppedNotice messageId="msg-1" />);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.queryByText(/disable auto-read/i)).toBeNull();
  });

  it('renders the notice when the message id is in stoppedStreamIds', async () => {
    useTtsPlaybackStore.getState().markStreamStopped('msg-1');
    renderInRouter(<TtsStoppedNotice messageId="msg-1" />);
    expect(await screen.findByText(/disable auto-read/i)).toBeInTheDocument();
  });

  it('only renders for messages the user actually stopped', () => {
    useTtsPlaybackStore.getState().markStreamStopped('other-msg');
    const { container } = renderInRouter(<TtsStoppedNotice messageId="msg-1" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('includes a link pointing to the accessibility settings page', async () => {
    useTtsPlaybackStore.getState().markStreamStopped('msg-1');
    renderInRouter(<TtsStoppedNotice messageId="msg-1" />);
    const link = await screen.findByRole('link', { name: /accessibility settings/i });
    expect(link).toHaveAttribute('href', '/accessibility');
  });

  it('uses muted-foreground text styling with no border or icon', async () => {
    useTtsPlaybackStore.getState().markStreamStopped('msg-1');
    const { container } = renderInRouter(<TtsStoppedNotice messageId="msg-1" />);
    await screen.findByText(/disable auto-read/i);
    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.className).toMatch(/text-muted-foreground/);
    expect(paragraph?.className).not.toMatch(/border/);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('does not render a dismiss button', async () => {
    useTtsPlaybackStore.getState().markStreamStopped('msg-1');
    renderInRouter(<TtsStoppedNotice messageId="msg-1" />);
    await screen.findByText(/disable auto-read/i);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
