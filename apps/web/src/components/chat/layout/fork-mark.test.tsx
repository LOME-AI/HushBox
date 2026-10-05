import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForkMark } from '@/components/chat/layout/fork-mark';

describe('ForkMark', () => {
  it('names how many other branches part at the point', () => {
    render(<ForkMark more={2} onOpen={vi.fn<() => void>()} />);
    expect(screen.getByRole('button', { name: 'Branched here · 2 more' })).toBeInTheDocument();
  });

  it('says it opens a dialog', () => {
    render(<ForkMark more={1} onOpen={vi.fn<() => void>()} />);
    expect(screen.getByRole('button', { name: 'Branched here · 1 more' })).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    );
  });

  it('opens the branches when pressed', async () => {
    const onOpen = vi.fn<() => void>();
    render(<ForkMark more={2} onOpen={onOpen} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Branched here · 2 more' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps its icons out of the accessible name', () => {
    const { container } = render(<ForkMark more={2} onOpen={vi.fn<() => void>()} />);
    const icons = [...container.querySelectorAll('svg')];
    expect(icons.map((icon) => icon.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
  });

  it('marks itself as chrome around the conversation', () => {
    const { container } = render(<ForkMark more={2} onOpen={vi.fn<() => void>()} />);
    expect(container.firstElementChild).toHaveAttribute('data-chrome', '');
  });
});
