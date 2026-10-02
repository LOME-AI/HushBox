import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorState, IdleState, LoadingState } from './states';

describe('IdleState', () => {
  it('tells the user how to start an analysis', () => {
    render(<IdleState />);

    expect(screen.getByText('Analyze a page')).toBeInTheDocument();
    expect(screen.getByText(/Enter a URL or pick a page above/i)).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('names the URL currently being analyzed', () => {
    render(<LoadingState url="https://example.com/pricing" />);

    expect(screen.getByText('Analyzing…')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/pricing')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders the engine error envelope code and message', () => {
    render(<ErrorState code="analyze_failed" message="Failed to analyze the requested URL." />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('analyze_failed');
    expect(alert).toHaveTextContent('Failed to analyze the requested URL.');
  });
});
