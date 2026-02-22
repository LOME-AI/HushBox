import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StepFlow } from './step-flow';

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

  describe('animated prop', () => {
    it('sets data-animated attribute', () => {
      render(<StepFlow steps={STEPS} animated data-testid="flow" />);
      expect(screen.getByTestId('flow')).toHaveAttribute('data-animated');
    });

    it('sets data-visible to false initially', () => {
      render(<StepFlow steps={STEPS} animated data-testid="flow" />);
      expect(screen.getByTestId('flow')).toHaveAttribute('data-visible', 'false');
    });

    it('sets --step-delay CSS custom property on each step', () => {
      render(<StepFlow steps={STEPS} animated data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems[0]).toHaveStyle('--step-delay: 0ms');
      expect(stepItems[1]).toHaveStyle('--step-delay: 150ms');
      expect(stepItems[2]).toHaveStyle('--step-delay: 300ms');
    });
  });

  describe('step items', () => {
    it('each step has data-slot="step-item"', () => {
      render(<StepFlow steps={STEPS} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems).toHaveLength(3);
    });
  });

  describe('highlightStep prop', () => {
    it('applies highlight styling to the specified step', () => {
      render(<StepFlow steps={STEPS} highlightStep={1} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems[1]).toHaveClass('border-l-2');
      expect(stepItems[1]).toHaveClass('border-primary');
    });

    it('does not apply highlight to non-highlighted steps', () => {
      render(<StepFlow steps={STEPS} highlightStep={1} data-testid="flow" />);
      const stepItems = screen.getByTestId('flow').querySelectorAll('[data-slot="step-item"]');
      expect(stepItems[0]).not.toHaveClass('border-l-2');
      expect(stepItems[2]).not.toHaveClass('border-l-2');
    });
  });
});
