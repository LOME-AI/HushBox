import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notice } from './notice';
import { NoticeDismiss } from './notice-dismiss';
import type { IconGlyphProps } from '../icons/icon';

function Glyph(props: Readonly<IconGlyphProps>): React.JSX.Element {
  return <svg {...props} />;
}

describe('NoticeDismiss', () => {
  it('is named for what it does', () => {
    render(<NoticeDismiss onDismiss={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAccessibleName('Dismiss notification');
  });

  it('takes the name its caller gives it', () => {
    render(<NoticeDismiss onDismiss={vi.fn()} aria-label="Hide this tip" />);

    expect(screen.getByRole('button')).toHaveAccessibleName('Hide this tip');
  });

  it('dismisses when pressed', async () => {
    const onDismiss = vi.fn();
    render(<NoticeDismiss onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('carries its test id', () => {
    render(<NoticeDismiss onDismiss={vi.fn()} data-testid="dismiss" />);

    expect(screen.getByRole('button')).toHaveAttribute('data-testid', 'dismiss');
  });

  it('draws a 1.5rem square in the composer', () => {
    render(
      <Notice
        tone="warning"
        icon={Glyph}
        placement="composer"
        end={<NoticeDismiss onDismiss={vi.fn()} />}
      />
    );

    expect(screen.getByRole('button')).toHaveAttribute('data-size', '2xs');
  });

  it('extends its touch target in the composer without growing the notice', () => {
    render(
      <Notice
        tone="warning"
        icon={Glyph}
        placement="composer"
        end={<NoticeDismiss onDismiss={vi.fn()} />}
      />
    );

    expect(screen.getByRole('button')).toHaveClass('pointer-coarse:before:size-11');
    expect(screen.getByRole('button')).not.toHaveClass('pointer-coarse:size-11');
  });

  it('draws a 0.75rem cross in ink in the composer', () => {
    render(
      <Notice
        tone="warning"
        icon={Glyph}
        placement="composer"
        end={<NoticeDismiss onDismiss={vi.fn()} />}
      />
    );

    expect(screen.getByRole('button')).toHaveClass('[&_svg]:size-3', 'text-foreground');
  });

  it('draws a 1.75rem square in muted ink elsewhere', () => {
    render(<Notice tone="warning" icon={Glyph} end={<NoticeDismiss onDismiss={vi.fn()} />} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('data-size', 'xs');
    expect(button).toHaveClass('text-muted-foreground');
  });

  it('grows its square to the touch target elsewhere', () => {
    render(<Notice tone="warning" icon={Glyph} end={<NoticeDismiss onDismiss={vi.fn()} />} />);

    expect(screen.getByRole('button')).toHaveClass('pointer-coarse:size-11');
  });
});
