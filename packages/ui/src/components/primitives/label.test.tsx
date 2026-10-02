import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Label } from './label';

describe('Label', () => {
  it('renders children', () => {
    render(<Label>Email address</Label>);
    expect(screen.getByText('Email address')).toBeInTheDocument();
  });

  it('renders as a label element', () => {
    render(<Label>Username</Label>);
    expect(screen.getByText('Username').tagName).toBe('LABEL');
  });

  it('applies htmlFor prop', () => {
    render(<Label htmlFor="email-input">Email</Label>);
    expect(screen.getByText('Email')).toHaveAttribute('for', 'email-input');
  });

  it('applies custom className', () => {
    render(<Label className="custom-class">Custom</Label>);
    expect(screen.getByText('Custom')).toHaveClass('custom-class');
  });

  it('has data-slot attribute for styling', () => {
    render(<Label>Styled</Label>);
    expect(screen.getByText('Styled')).toHaveAttribute('data-slot', 'label');
  });

  it('forwards additional props', () => {
    render(<Label data-testid="my-label">Test</Label>);
    expect(screen.getByTestId('my-label')).toBeInTheDocument();
  });

  it('renders with associated checkbox', () => {
    render(
      <div>
        <Label htmlFor="terms">Accept terms</Label>
        <input type="checkbox" id="terms" />
      </div>
    );
    expect(screen.getByLabelText('Accept terms')).toBeInTheDocument();
  });

  it('renders with associated input', () => {
    render(
      <div>
        <Label htmlFor="username">Username</Label>
        <input type="text" id="username" />
      </div>
    );
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });
});
