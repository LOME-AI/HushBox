import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import section from './text-field.section';

describe('the text field kit section', () => {
  it('is compared against catalog part 3', () => {
    expect(section.part).toBe(3);
  });

  it('draws the empty field', () => {
    render(<>{section.render()}</>);

    const empty = screen
      .getAllByLabelText('Username')
      .filter((field) => field instanceof HTMLInputElement && field.value === '');
    expect(empty.length).toBeGreaterThan(0);
  });

  it('draws a filled field', () => {
    render(<>{section.render()}</>);

    expect(screen.getByDisplayValue('alice@example')).toHaveAttribute('aria-invalid', 'true');
  });

  it('draws the error line', () => {
    render(<>{section.render()}</>);

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
  });

  it('draws the success line', () => {
    render(<>{section.render()}</>);

    expect(screen.getByText('Username is available')).toBeInTheDocument();
  });

  it('draws a disabled field', () => {
    render(<>{section.render()}</>);

    expect(screen.getByLabelText('Amount (USD)')).toBeDisabled();
  });

  it('draws the message box', () => {
    render(<>{section.render()}</>);

    expect(screen.getByLabelText('What you type').tagName).toBe('TEXTAREA');
  });

  it('draws a field named without a visible label', () => {
    render(<>{section.render()}</>);

    expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveAttribute(
      'placeholder',
      'Search models'
    );
  });

  it('draws the inline input', () => {
    render(<>{section.render()}</>);

    expect(screen.getByRole('textbox', { name: 'Search members' })).toBeInTheDocument();
  });

  it('reveals the password from its suffix', async () => {
    const user = userEvent.setup();
    render(<>{section.render()}</>);
    const password = screen.getByLabelText('Password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(password).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
  });

  it('asks the browser for the saved password', () => {
    render(<>{section.render()}</>);

    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });
});
