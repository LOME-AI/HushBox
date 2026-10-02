import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip, TooltipContent, TooltipTrigger, TouchDeviceOverrideContext } from '@hushbox/ui';
import { Chip } from '@/components/shared/chip';
import { usePressTooltip } from './use-press-tooltip';

interface HarnessProps {
  onPress?: () => void;
  disabled?: boolean;
}

/** A chip whose presses count up, its tooltip naming the count the last press left. */
function CountingChip({ onPress, disabled = false }: Readonly<HarnessProps>): React.JSX.Element {
  const [presses, setPresses] = React.useState(0);
  const tooltip = usePressTooltip(() => {
    setPresses((count) => count + 1);
    onPress?.();
  });
  return (
    <>
      <Tooltip {...tooltip.root}>
        <TooltipTrigger asChild>
          <Chip label="Count" disabled={disabled} {...tooltip.trigger} />
        </TooltipTrigger>
        <TooltipContent side="top">{`Pressed ${String(presses)}`}</TooltipContent>
      </Tooltip>
      <button type="button">Elsewhere</button>
    </>
  );
}

function renderChip(touch: boolean, props: HarnessProps = {}): HTMLElement {
  render(
    <TouchDeviceOverrideContext value={touch}>
      <CountingChip {...props} />
    </TouchDeviceOverrideContext>
  );
  return screen.getByRole('button', { name: 'Count' });
}

describe('usePressTooltip', () => {
  it('opens the tooltip on a bare click, as a tap delivers it', async () => {
    const chip = renderChip(false);
    fireEvent.click(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pressed 1');
  });

  it('calls its press handler once per press', async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();
    const chip = renderChip(false, { onPress });
    await user.click(chip);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('opens the tooltip on a press its trigger refuses, so a disabled chip still says why', async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();
    const chip = renderChip(true, { onPress, disabled: true });
    await user.pointer({ keys: '[TouchA]', target: chip });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pressed 0');
  });

  it('keeps the tooltip open through a second tap on a touch screen', async () => {
    const user = userEvent.setup();
    const chip = renderChip(true);
    await user.pointer({ keys: '[TouchA]', target: chip });
    await user.pointer({ keys: '[TouchA]', target: chip });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pressed 2');
  });

  it('keeps the tooltip open while a second touch is still down', async () => {
    const user = userEvent.setup();
    const chip = renderChip(true);
    await user.pointer({ keys: '[TouchA]', target: chip });
    await user.pointer({ keys: '[TouchA>]', target: chip });
    expect(chip).not.toHaveAttribute('data-state', 'closed');
  });

  it('keeps the tooltip open through a second click with a mouse', async () => {
    const user = userEvent.setup();
    const chip = renderChip(false);
    await user.click(chip);
    await user.click(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pressed 2');
  });

  it('keeps the tooltip open through a second press from the keyboard', async () => {
    const user = userEvent.setup();
    const chip = renderChip(true);
    await user.pointer({ keys: '[TouchA]', target: chip });
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pressed 2');
  });

  it('closes the tooltip on a tap elsewhere', async () => {
    const user = userEvent.setup();
    const chip = renderChip(true);
    await user.pointer({ keys: '[TouchA]', target: chip });
    await screen.findByRole('tooltip');
    await user.pointer({
      keys: '[TouchA]',
      target: screen.getByRole('button', { name: 'Elsewhere' }),
    });
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('closes the tooltip on Escape', async () => {
    const user = userEvent.setup();
    const chip = renderChip(true);
    await user.pointer({ keys: '[TouchA]', target: chip });
    await screen.findByRole('tooltip');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });
});
