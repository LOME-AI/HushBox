import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { SearchChip } from './search-chip';

interface HarnessProps {
  webSearchEnabled?: boolean;
  canUse?: boolean;
  onToggle?: () => void;
}

function renderChip({
  webSearchEnabled = false,
  canUse = true,
  onToggle = vi.fn(),
}: HarnessProps = {}): void {
  render(<SearchChip webSearchEnabled={webSearchEnabled} canUse={canUse} onToggle={onToggle} />);
}

/** The chip as a composer holds it: each press flips search. */
function TogglingChip(): React.JSX.Element {
  const [webSearchEnabled, setWebSearchEnabled] = React.useState(false);
  return (
    <SearchChip
      webSearchEnabled={webSearchEnabled}
      canUse
      onToggle={() => {
        setWebSearchEnabled((was) => !was);
      }}
    />
  );
}

describe('SearchChip', () => {
  describe('while search is off', () => {
    it('is named for turning search on', () => {
      renderChip();
      expect(screen.getByRole('button', { name: 'Turn on internet search' })).toBeInTheDocument();
    });

    it('is not pressed', () => {
      renderChip();
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('while search is on', () => {
    it('is named for turning search off', () => {
      renderChip({ webSearchEnabled: true });
      expect(screen.getByRole('button', { name: 'Turn off internet search' })).toBeInTheDocument();
    });

    it('is pressed, so it draws on the red tint', () => {
      renderChip({ webSearchEnabled: true });
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('shows the word "Search"', () => {
    renderChip();
    expect(screen.getByRole('button')).toHaveTextContent('Search');
  });

  it('draws the globe', () => {
    renderChip();
    expect(screen.getByRole('button').querySelector('svg.lucide-globe')).not.toBeNull();
  });

  it('toggles search when pressed', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderChip({ onToggle });
    await user.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('keeps its tooltip open on a touch screen through a second tap, naming the state that tap left', async () => {
    const user = userEvent.setup();
    render(
      <TouchDeviceOverrideContext value={true}>
        <TogglingChip />
      </TouchDeviceOverrideContext>
    );
    const chip = screen.getByRole('button');
    await user.pointer({ keys: '[TouchA]', target: chip });
    await user.pointer({ keys: '[TouchA]', target: chip });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn on internet search');
  });

  it("shows today's words in its tooltip on hover", async () => {
    const user = userEvent.setup();
    renderChip({ webSearchEnabled: true });
    await user.hover(screen.getByRole('button'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn off internet search');
  });

  describe('for a visitor', () => {
    it('is named as unavailable', () => {
      renderChip({ canUse: false });
      expect(
        screen.getByRole('button', { name: 'Internet search unavailable' })
      ).toBeInTheDocument();
    });

    it('is marked disabled, so it draws dashed', () => {
      renderChip({ canUse: false });
      expect(screen.getByRole('button')).toHaveAttribute('aria-disabled', 'true');
    });

    it('is not pressed', () => {
      renderChip({ canUse: false, webSearchEnabled: true });
      expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed', 'true');
    });

    it('stays reachable from the keyboard', async () => {
      const user = userEvent.setup();
      renderChip({ canUse: false });
      await user.tab();
      expect(screen.getByRole('button')).toHaveFocus();
    });

    it('gives the sign-up reason once focused', async () => {
      const user = userEvent.setup();
      renderChip({ canUse: false });
      await user.tab();
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Sign up to access internet search'
      );
    });

    it('gives the sign-up reason on a tap', async () => {
      const user = userEvent.setup();
      renderChip({ canUse: false });
      await user.click(screen.getByRole('button'));
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Sign up to access internet search'
      );
    });

    it('does not toggle search when pressed', async () => {
      const onToggle = vi.fn();
      const user = userEvent.setup();
      renderChip({ canUse: false, onToggle });
      await user.click(screen.getByRole('button'));
      expect(onToggle).not.toHaveBeenCalled();
    });
  });
});
