import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { Presence } from './presence';
import { MOTION_TRANSITION } from './motion-transition';

vi.mock('framer-motion', async () => {
  const { framerMotionDouble } = await import('./motion-doubles.setup');
  return framerMotionDouble;
});

function motionWrapper(testId: string): HTMLElement | null {
  return screen.getByTestId(testId).closest<HTMLElement>('[data-motion="true"]');
}

describe('Presence', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
  });

  afterEach(() => {
    act(() => {
      useA11yStore.getState().reset();
    });
  });

  it('fades its content in on entry', () => {
    render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    const wrapper = motionWrapper('child');
    expect(wrapper?.dataset['initial']).toBe(JSON.stringify({ opacity: 0 }));
    expect(wrapper?.dataset['animate']).toBe(JSON.stringify({ opacity: 1 }));
  });

  it('fades its content out on exit', () => {
    render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    expect(motionWrapper('child')?.dataset['exit']).toBe(JSON.stringify({ opacity: 0 }));
  });

  it('times the fade by the base motion transition', () => {
    render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    expect(motionWrapper('child')?.dataset['transition']).toBe(
      JSON.stringify(MOTION_TRANSITION.base)
    );
  });

  it('marks each faded wrapper as animated', () => {
    render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    expect(motionWrapper('child')).toHaveAttribute('data-animated', 'true');
  });

  it('gives each child its own fade so siblings enter and leave independently', () => {
    render(
      <Presence>
        {['first', 'second'].map((id) => (
          <span key={id} data-testid={id}>
            {id}
          </span>
        ))}
      </Presence>
    );

    expect(motionWrapper('first')).not.toBe(motionWrapper('second'));
  });

  it('fades bare text content like an element', () => {
    render(
      <div data-testid="host">
        <Presence>plain text</Presence>
      </div>
    );

    expect(screen.getByText('plain text')).toHaveAttribute('data-animated', 'true');
  });

  it('removes a child that leaves', () => {
    const { rerender } = render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    rerender(<Presence>{null}</Presence>);

    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('plays the entry fade on first render by default', () => {
    const { container } = render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    expect(container.querySelector('[data-presence-initial]')).toHaveAttribute(
      'data-presence-initial',
      'true'
    );
  });

  it('skips the entry fade on first render when initial is false', () => {
    const { container } = render(
      <Presence initial={false}>
        <span data-testid="child">visible</span>
      </Presence>
    );

    expect(container.querySelector('[data-presence-initial]')).toHaveAttribute(
      'data-presence-initial',
      'false'
    );
  });

  it('renders its content with no fade when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <Presence>
        <span data-testid="child">visible</span>
      </Presence>
    );

    expect(motionWrapper('child')).toBeNull();
    expect(screen.getByTestId('child').parentElement).toHaveAttribute('data-animated', 'false');
  });
});
