import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { PasswordStrength } from './password-strength';

describe('PasswordStrength', () => {
  it('starts with collapsed container when password is empty', () => {
    render(<PasswordStrength password="" />);
    const container = screen.getByTestId(TEST_IDS.strengthIndicator);
    expect(container).toBeInTheDocument();
    expect(container).toHaveClass('h-0');
  });

  it('expands container when password has value', () => {
    render(<PasswordStrength password="test" />);
    const container = screen.getByTestId(TEST_IDS.strengthIndicator);
    expect(container).toHaveClass('h-6');
  });

  it('shows weak strength for passwords under 8 characters', () => {
    render(<PasswordStrength password="abc" />);
    expect(screen.getByText(/weak/i)).toBeInTheDocument();
  });

  it('shows weak strength for 8+ chars with no criteria', () => {
    render(<PasswordStrength password="abcdefgh" />);
    expect(screen.getByText(/weak/i)).toBeInTheDocument();
  });

  it('shows medium strength for 8+ chars with 1 criteria', () => {
    render(<PasswordStrength password="Abcdefgh" />);
    expect(screen.getByText(/medium/i)).toBeInTheDocument();
  });

  it('shows medium strength for 10+ chars with 1 criteria', () => {
    render(<PasswordStrength password="Abcdefghij" />);
    expect(screen.getByText(/medium/i)).toBeInTheDocument();
  });

  it('shows strong strength for 10+ chars with 2+ criteria', () => {
    render(<PasswordStrength password="Password12" />);
    expect(screen.getByText(/strong/i)).toBeInTheDocument();
  });

  it('shows strong strength for password with 10+ chars, digit and special', () => {
    render(<PasswordStrength password="password1!" />);
    expect(screen.getByText(/strong/i)).toBeInTheDocument();
  });

  it('has correct number of segments (always 3)', () => {
    render(<PasswordStrength password="password" />);
    expect(screen.getAllByTestId(TEST_IDS.strengthSegment)).toHaveLength(3);
  });

  it('uses accessible text contrast for strength label', () => {
    render(<PasswordStrength password="test" />);
    const label = screen.getByText(/weak/i);
    expect(label).toHaveClass('text-muted-foreground');
  });
});
