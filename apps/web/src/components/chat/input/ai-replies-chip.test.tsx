import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { AiRepliesChip } from './ai-replies-chip';

const NAME = 'AI replies to this message';

function renderChip({
  enabled = true,
  onToggle = vi.fn(),
}: { enabled?: boolean; onToggle?: () => void } = {}): void {
  render(<AiRepliesChip enabled={enabled} onToggle={onToggle} />);
}

describe('AiRepliesChip', () => {
  it('is named for what it controls', () => {
    renderChip();
    expect(screen.getByRole('button', { name: NAME })).toBeInTheDocument();
  });

  it('is pressed while AI replies are on', () => {
    renderChip({ enabled: true });
    expect(screen.getByRole('button', { name: NAME })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is not pressed while AI replies are off', () => {
    renderChip({ enabled: false });
    expect(screen.getByRole('button', { name: NAME })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onToggle when pressed', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderChip({ onToggle });
    await user.click(screen.getByRole('button', { name: NAME }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('draws the bot while pressed', () => {
    renderChip({ enabled: true });
    expect(screen.getByRole('button').querySelector('svg.lucide-bot')).not.toBeNull();
  });

  it('draws the message icon while not pressed', () => {
    renderChip({ enabled: false });
    expect(screen.getByRole('button').querySelector('svg.lucide-message-square')).not.toBeNull();
  });

  describe('its label, by the composer width', () => {
    it('reads "AI replies" on a wide composer', () => {
      renderChip();
      expect(screen.getByText('AI replies')).not.toHaveClass('hidden');
    });

    it('drops "AI replies" on a composer narrower than 34rem', () => {
      renderChip();
      expect(screen.getByText('AI replies')).toHaveClass('@max-composer-compact/composer:hidden');
    });

    it('hides "AI" on a wide composer', () => {
      renderChip();
      expect(screen.getByText('AI')).toHaveClass('hidden');
    });

    it('reads "AI" on a composer narrower than 34rem', () => {
      renderChip();
      expect(screen.getByText('AI')).toHaveClass('@max-composer-compact/composer:inline');
    });

    it('drops "AI" on a composer narrower than 24rem, leaving the icon alone', () => {
      renderChip();
      expect(screen.getByText('AI')).toHaveClass('@max-composer-ai-icon/composer:hidden');
    });

    it('squares to the icon on a composer narrower than 24rem', () => {
      renderChip();
      expect(screen.getByRole('button')).toHaveClass(
        '@max-composer-ai-icon/composer:w-8',
        '@max-composer-ai-icon/composer:px-0',
        '@max-composer-ai-icon/composer:justify-center'
      );
    });

    it('keeps the short label out of the accessible name', () => {
      renderChip();
      expect(screen.getByText('AI')).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('its tooltip', () => {
    it('offers to turn AI replies off while they are on', async () => {
      const user = userEvent.setup();
      renderChip({ enabled: true });
      await user.hover(screen.getByRole('button', { name: NAME }));
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn off AI replies');
    });

    it('offers to turn AI replies on while they are off', async () => {
      const user = userEvent.setup();
      renderChip({ enabled: false });
      await user.hover(screen.getByRole('button', { name: NAME }));
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn on AI replies');
    });

    it('opens on a tap, so a touch screen shows it too', async () => {
      renderChip({ enabled: false });
      // A bare click event, with no pointer moving over the chip first, as a tap delivers it.
      fireEvent.click(screen.getByRole('button', { name: NAME }));
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn on AI replies');
    });

    it('stays open on a touch screen through a second tap, naming the state that tap left', async () => {
      const user = userEvent.setup();
      render(
        <TouchDeviceOverrideContext value={true}>
          <TogglingChip />
        </TouchDeviceOverrideContext>
      );
      const chip = screen.getByRole('button', { name: NAME });
      await user.pointer({ keys: '[TouchA]', target: chip });
      await user.pointer({ keys: '[TouchA]', target: chip });
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn on AI replies');
    });
  });
});

/** The chip as a composer holds it: each press flips the state it shows. */
function TogglingChip(): React.JSX.Element {
  const [enabled, setEnabled] = React.useState(false);
  return (
    <AiRepliesChip
      enabled={enabled}
      onToggle={() => {
        setEnabled((was) => !was);
      }}
    />
  );
}
