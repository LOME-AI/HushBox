import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StepFlow } from './step-flow';
import type * as React from 'react';

const STEPS = [
  { title: 'Step 1', description: 'First step' },
  { title: 'Step 2', description: 'Second step' },
  { title: 'Step 3', description: 'Third step' },
];

describe('StepFlow', () => {
  it('renders all step titles', () => {
    render(<StepFlow steps={STEPS} />);
    expect(screen.getByText('Step 1')).toBeInTheDocument();
    expect(screen.getByText('Step 2')).toBeInTheDocument();
    expect(screen.getByText('Step 3')).toBeInTheDocument();
  });

  it('renders all step descriptions', () => {
    render(<StepFlow steps={STEPS} />);
    expect(screen.getByText('First step')).toBeInTheDocument();
    expect(screen.getByText('Second step')).toBeInTheDocument();
    expect(screen.getByText('Third step')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<StepFlow steps={STEPS} data-testid="flow" />);
    expect(screen.getByTestId('flow')).toHaveAttribute('data-slot', 'step-flow');
  });

  it('applies direction as data attribute', () => {
    render(<StepFlow steps={STEPS} direction="horizontal" data-testid="flow" />);
    expect(screen.getByTestId('flow')).toHaveAttribute('data-direction', 'horizontal');
  });

  it('defaults to vertical direction', () => {
    render(<StepFlow steps={STEPS} data-testid="flow" />);
    expect(screen.getByTestId('flow')).toHaveAttribute('data-direction', 'vertical');
  });

  it('applies custom className', () => {
    render(<StepFlow steps={STEPS} className="custom-class" data-testid="flow" />);
    expect(screen.getByTestId('flow')).toHaveClass('custom-class');
  });

  it('renders step numbers', () => {
    render(<StepFlow steps={STEPS} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  describe('connected prop', () => {
    it('sets data-connected attribute', () => {
      render(<StepFlow steps={STEPS} connected data-testid="flow" />);
      expect(screen.getByTestId('flow')).toHaveAttribute('data-connected');
    });

    it('does not set data-connected by default', () => {
      render(<StepFlow steps={STEPS} data-testid="flow" />);
      expect(screen.getByTestId('flow')).not.toHaveAttribute('data-connected');
    });
  });

  it('draws the steps as an ordered list', () => {
    render(<StepFlow steps={STEPS} />);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('takes no animation prop', () => {
    const props: React.ComponentProps<typeof StepFlow> = {
      steps: STEPS,
      // @ts-expect-error -- the steps are drawn at rest; no prop animates them
      animated: true,
    };
    expect(props.steps).toBe(STEPS);
  });

  describe('step items', () => {
    it('each step has data-slot="step-item"', () => {
      render(<StepFlow steps={STEPS} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems).toHaveLength(3);
    });
  });

  describe('highlightStep prop', () => {
    it('pulls the highlighted step back by its own inset, so its number stays in the column', () => {
      render(<StepFlow steps={STEPS} highlightStep={1} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems[1]).toHaveClass('-ml-4', 'pl-4');
    });

    it('marks the specified step as the current one', () => {
      render(<StepFlow steps={STEPS} highlightStep={1} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems[1]).toHaveAttribute('aria-current', 'step');
    });

    it('marks no other step as current', () => {
      render(<StepFlow steps={STEPS} highlightStep={1} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems[0]).not.toHaveAttribute('aria-current');
      expect(stepItems[2]).not.toHaveAttribute('aria-current');
    });

    it('marks no step as current when no step is highlighted', () => {
      render(<StepFlow steps={STEPS} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      for (const item of stepItems) {
        expect(item).not.toHaveAttribute('aria-current');
      }
    });
  });
});

describe('the connecting line', () => {
  const css = readFileSync(path.resolve(__dirname, '../../styles/global.css'), 'utf8');

  it('runs from under one number to the top of the next, across the gap between steps', () => {
    expect(css).toMatch(
      /\[data-slot='step-flow'\]\[data-connected\] \[data-slot='step-item'\]:not\(:last-child\)::after \{[^}]*top: 2rem;[^}]*height: calc\(100% - 0\.5rem\);/
    );
  });

  it('follows the highlighted step inward by its inset and its padding', () => {
    expect(css).toMatch(
      /\[data-slot='step-flow'\]\[data-connected\] \[data-slot='step-item'\]\[aria-current\]::after \{\s*left: calc\(15px \+ 1rem\);\s*top: 2\.5rem;\s*height: calc\(100% - 1rem\);\s*\}/
    );
  });
});
