import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { Facepile } from './facepile';

const noop = (): void => {};

function members(count: number): { name: string; online: boolean }[] {
  return ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'].slice(0, count).map((name) => ({
    name,
    online: name === 'Alice',
  }));
}

describe('Facepile', () => {
  it('is one button named by the member count', () => {
    render(<Facepile members={members(2)} onOpen={noop} />);

    expect(screen.getByRole('button', { name: 'Members (2)' })).toHaveAttribute('type', 'button');
  });

  it('draws at most three avatars', () => {
    const { container } = render(<Facepile members={members(5)} onOpen={noop} />);

    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3);
  });

  it('counts the members past three as +N', () => {
    render(<Facepile members={members(5)} onOpen={noop} />);

    expect(screen.getByRole('button', { name: 'Members (5)' })).toHaveTextContent(/\+2$/);
  });

  it('draws no count when three members fit', () => {
    render(<Facepile members={members(3)} onOpen={noop} />);

    expect(screen.getByRole('button')).not.toHaveTextContent('+');
  });

  it('draws the first three members in order', () => {
    render(<Facepile members={members(5)} onOpen={noop} />);

    expect(screen.getByRole('button')).toHaveTextContent('ABC+2');
  });

  it('rings the members who are online', () => {
    const { container } = render(<Facepile members={members(3)} onOpen={noop} />);

    const online = container.querySelectorAll('[data-slot="avatar"][data-online]');
    expect(online).toHaveLength(1);
    expect(online[0]).toHaveTextContent('A');
  });

  it('draws nothing when there are no members', () => {
    const { container } = render(<Facepile members={[]} onOpen={noop} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('opens the member list on a click', async () => {
    const onOpen = vi.fn();
    render(<Facepile members={members(2)} onOpen={onOpen} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('passes native attributes to its button', () => {
    render(<Facepile members={members(2)} onOpen={noop} data-testid={TEST_IDS.memberFacepile} />);

    expect(screen.getByTestId(TEST_IDS.memberFacepile)).toHaveAccessibleName('Members (2)');
  });

  it('overlaps its avatars, each rimmed in the page colour', () => {
    render(<Facepile members={members(3)} onOpen={noop} />);

    expect(screen.getByRole('button')).toHaveClass(
      'flex',
      'items-center',
      '[&>*+*]:-ml-1.5',
      '[&>[data-slot=avatar]]:shadow-[0_0_0_2px_var(--background)]'
    );
  });

  it('draws a thinner success ring on an online avatar in the pile', () => {
    render(<Facepile members={members(3)} onOpen={noop} />);

    expect(screen.getByRole('button')).toHaveClass(
      '[&>[data-slot=avatar][data-online]]:shadow-[0_0_0_2px_var(--background),0_0_0_3.5px_var(--success)]'
    );
  });

  it('draws the count as a small muted pill', () => {
    render(<Facepile members={members(4)} onOpen={noop} />);

    expect(screen.getByText('+1')).toHaveClass(
      'h-6',
      'rounded-full',
      'bg-background-subtle',
      'text-muted-foreground',
      'text-xs',
      'font-medium'
    );
  });

  it('shows the pointer cursor', () => {
    render(<Facepile members={members(2)} onOpen={noop} />);

    expect(screen.getByRole('button')).toHaveClass('cursor-pointer');
  });

  it('reaches a 2.75rem target on a coarse pointer', () => {
    render(<Facepile members={members(2)} onOpen={noop} />);

    expect(screen.getByRole('button')).toHaveClass(
      'relative',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:inset-x-0',
      'pointer-coarse:before:-inset-y-2'
    );
  });
});
