import * as React from 'react';
import { render, screen, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useRootTheme } from './use-root-theme';

function ThemeProbe(): React.JSX.Element {
  return <span data-testid="probe">{useRootTheme()}</span>;
}

async function flipRootClass(add: boolean): Promise<void> {
  // The MutationObserver behind the hook delivers on a microtask, so the
  // awaited resolve is what drains it inside the act.
  await act(async () => {
    document.documentElement.classList.toggle('dark', add);
    await Promise.resolve();
  });
}

describe('useRootTheme', () => {
  afterEach(async () => {
    await flipRootClass(false);
    vi.restoreAllMocks();
  });

  it('reads light when the root element carries no dark class', () => {
    render(<ThemeProbe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('light');
  });

  it('reads dark when the root element carries the dark class', async () => {
    await flipRootClass(true);
    render(<ThemeProbe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('dark');
  });

  it('re-reads when the root class flips after mount', async () => {
    render(<ThemeProbe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('light');

    await flipRootClass(true);

    expect(screen.getByTestId('probe')).toHaveTextContent('dark');
  });

  it('stops observing the root element once the consumer unmounts', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const view = render(<ThemeProbe />);
    expect(disconnect).not.toHaveBeenCalled();

    view.unmount();

    expect(disconnect).toHaveBeenCalled();
  });

  // `ThemeToggle` is a `client:load` island on the Astro marketing site, so it is
  // server-rendered at build time where no root element exists and hydration has
  // to match the emitted HTML.
  it('renders light on the server even when a document root would read dark', async () => {
    await flipRootClass(true);

    expect(renderToString(<ThemeProbe />)).toContain('light');
  });
});
