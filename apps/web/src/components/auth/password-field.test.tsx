import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PasswordField, ConfirmPasswordField } from './password-field';

describe('PasswordField', () => {
  const baseProps = {
    id: 'password',
    label: 'Password',
    password: '',
    setPassword: vi.fn(),
    touched: false,
    markTouched: vi.fn(),
  };

  it('forwards the autoComplete prop to the input', () => {
    render(<PasswordField {...baseProps} autoComplete="current-password" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });
});

describe('ConfirmPasswordField', () => {
  const baseProps = {
    id: 'confirm-password',
    label: 'Confirm Password',
    newPassword: '',
    confirmPassword: '',
    setConfirmPassword: vi.fn(),
    touched: false,
    markTouched: vi.fn(),
  };

  it('marks the input with new-password autocomplete', () => {
    render(<ConfirmPasswordField {...baseProps} />);

    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute(
      'autocomplete',
      'new-password'
    );
  });
});
