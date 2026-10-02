import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverlayBody } from './overlay-body';

describe('OverlayBody', () => {
  it('renders its children', () => {
    render(
      <OverlayBody>
        <p>Field</p>
      </OverlayBody>
    );

    expect(screen.getByText('Field')).toBeInTheDocument();
  });

  it('stacks its blocks 1rem apart', () => {
    render(
      <OverlayBody>
        <p>Field</p>
      </OverlayBody>
    );

    expect(screen.getByText('Field').parentElement).toHaveClass('flex', 'flex-col', 'gap-4');
  });

  it('shrinks and scrolls when the overlay is taller than the room', () => {
    render(
      <OverlayBody>
        <p>Field</p>
      </OverlayBody>
    );

    expect(screen.getByText('Field').parentElement).toHaveClass('min-h-0', 'overflow-y-auto');
  });

  it('leaves 0.875rem inside its inline scroll edges for a coarse hit area, without moving content', () => {
    render(
      <OverlayBody>
        <p>Field</p>
      </OverlayBody>
    );

    expect(screen.getByText('Field').parentElement).toHaveClass('-mx-3.5', 'px-3.5');
  });

  it('leaves 0.25rem inside its block scroll edges for a focus ring, without moving content', () => {
    render(
      <OverlayBody>
        <p>Field</p>
      </OverlayBody>
    );

    expect(screen.getByText('Field').parentElement).toHaveClass('-my-1', 'py-1');
  });
});
