import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useA11yStore } from '../accessibility/store';
import { AsyncRegion, type SkeletonShape } from './async-region';

const SHAPES: readonly SkeletonShape[] = [
  { kind: 'line', width: '40%' },
  { kind: 'block', height: 'md' },
  { kind: 'circle' },
];

function region(): HTMLElement {
  return screen.getByRole('group', { name: 'Purchase history' });
}

function skeletons(): HTMLElement[] {
  return [...region().querySelectorAll<HTMLElement>('[data-slot="skeleton"]')];
}

describe('AsyncRegion', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
    // A VITE_E2E left over from an e2e run would force reduced motion on.
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    // Unmount first: resetting the store under a mounted region re-renders each
    // skeleton's reduced-motion subscription outside act.
    cleanup();
    useA11yStore.getState().reset();
    vi.unstubAllEnvs();
  });

  describe('pending', () => {
    it('marks itself busy', () => {
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(region()).toHaveAttribute('aria-busy', 'true');
    });

    it('draws one skeleton per placeholder shape', () => {
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(skeletons()).toHaveLength(3);
    });

    it('holds back its children', () => {
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(screen.queryByText('Deposits')).not.toBeInTheDocument();
    });

    it('draws a line at the width it is given', () => {
      render(
        <AsyncRegion
          status="pending"
          label="Purchase history"
          placeholder={[{ kind: 'line', width: '40%' }]}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      const [line] = skeletons();
      expect(line).toHaveStyle({ width: '40%' });
      expect(line).toHaveClass('h-3');
    });

    it.each([
      ['sm', 'h-12'],
      ['md', 'h-24'],
      ['lg', 'h-48'],
    ] as const)('draws a %s block at %s', (height, heightClass) => {
      render(
        <AsyncRegion
          status="pending"
          label="Purchase history"
          placeholder={[{ kind: 'block', height }]}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      const [block] = skeletons();
      expect(block).toHaveClass(heightClass, 'w-full');
    });

    it('draws a circle as a round mark', () => {
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={[{ kind: 'circle' }]}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      const [circle] = skeletons();
      expect(circle).toHaveClass('size-7', 'rounded-full');
    });

    it('hides the placeholder from assistive technology', () => {
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(region().querySelector('[data-slot="async-region-placeholder"]')).toHaveAttribute(
        'aria-hidden',
        'true'
      );
    });

    it('pulses its skeletons when motion is not reduced', () => {
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      for (const skeleton of skeletons()) {
        expect(skeleton).toHaveAttribute('data-animated', 'true');
      }
    });

    it('stops its skeletons pulsing under reduced motion', () => {
      act(() => {
        useA11yStore.getState().update({ stopAnimations: true });
      });
      render(
        <AsyncRegion status="pending" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      for (const skeleton of skeletons()) {
        expect(skeleton).toHaveAttribute('data-animated', 'false');
        expect(skeleton).not.toHaveClass('animate-pulse');
      }
    });
  });

  describe('error', () => {
    it('shows the error message as an alert', () => {
      render(
        <AsyncRegion
          status="error"
          label="Purchase history"
          placeholder={SHAPES}
          error={{ message: "Couldn't load your purchases." }}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your purchases.");
    });

    it('is not busy', () => {
      render(
        <AsyncRegion
          status="error"
          label="Purchase history"
          placeholder={SHAPES}
          error={{ message: "Couldn't load your purchases." }}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(region()).not.toHaveAttribute('aria-busy');
    });

    it('draws neither the placeholder nor the children', () => {
      render(
        <AsyncRegion
          status="error"
          label="Purchase history"
          placeholder={SHAPES}
          error={{ message: "Couldn't load your purchases." }}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(skeletons()).toHaveLength(0);
      expect(screen.queryByText('Deposits')).not.toBeInTheDocument();
    });

    it('offers no retry when none is given', () => {
      render(
        <AsyncRegion
          status="error"
          label="Purchase history"
          placeholder={SHAPES}
          error={{ message: "Couldn't load your purchases." }}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('retries when the retry button is pressed', async () => {
      const onRetry = vi.fn();
      render(
        <AsyncRegion
          status="error"
          label="Purchase history"
          placeholder={SHAPES}
          error={{ message: "Couldn't load your purchases.", onRetry }}
        >
          <p>Deposits</p>
        </AsyncRegion>
      );

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('says something went wrong when no message is given', () => {
      render(
        <AsyncRegion status="error" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this.");
    });
  });

  describe('ready', () => {
    it('draws its children', () => {
      render(
        <AsyncRegion status="ready" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(screen.getByText('Deposits')).toBeInTheDocument();
    });

    it('is not busy', () => {
      render(
        <AsyncRegion status="ready" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(region()).not.toHaveAttribute('aria-busy');
    });

    it('draws no placeholder', () => {
      render(
        <AsyncRegion status="ready" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(skeletons()).toHaveLength(0);
    });

    it('reports its status for styling and tests', () => {
      render(
        <AsyncRegion status="ready" label="Purchase history" placeholder={SHAPES}>
          <p>Deposits</p>
        </AsyncRegion>
      );

      expect(region()).toHaveAttribute('data-status', 'ready');
    });
  });
});
