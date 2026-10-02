import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthFeatureList } from './auth-feature-list';

describe('AuthFeatureList', () => {
  it('renders three feature items', () => {
    render(<AuthFeatureList />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
  });

  it('renders Privacy by design', () => {
    render(<AuthFeatureList />);
    expect(screen.getByText('Privacy by design')).toBeInTheDocument();
  });

  it('renders Access GPT, Claude, Gemini & more', () => {
    render(<AuthFeatureList />);
    expect(screen.getByText('Access GPT, Claude, Gemini & more')).toBeInTheDocument();
  });

  it('renders Your data is never sold or trained on', () => {
    render(<AuthFeatureList />);
    expect(screen.getByText('Your data is never sold or trained on')).toBeInTheDocument();
  });

  it('renders checkmark symbols', () => {
    render(<AuthFeatureList />);
    const checkmarks = screen.getAllByText('\u2713');
    expect(checkmarks).toHaveLength(3);
  });

  it('has border-top and padding', () => {
    const { container } = render(<AuthFeatureList />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('border-t');
    expect(wrapper).toHaveClass('pt-6');
  });
});
