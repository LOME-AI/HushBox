import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FieldMessage } from './field-message';

function row(): HTMLElement {
  const element = document.querySelector('#name-message');
  if (!(element instanceof HTMLElement)) throw new Error('no message row');
  return element;
}

describe('FieldMessage', () => {
  it('renders an empty row under its id when it holds no message', () => {
    render(<FieldMessage id="name-message" />);

    expect(row()).toBeEmptyDOMElement();
  });

  it('gives an empty row no top margin', () => {
    render(<FieldMessage id="name-message" />);

    expect(row().className.split(' ')).not.toContain('mt-1');
  });

  it('gives an empty row no height', () => {
    render(<FieldMessage id="name-message" />);

    expect(row().className.split(' ')).not.toContain('min-h-5');
  });

  it('gives an empty reserved row its top margin', () => {
    render(<FieldMessage id="name-message" reserve />);

    expect(row().className.split(' ')).toContain('mt-1');
  });

  it('gives an empty reserved row no height', () => {
    render(<FieldMessage id="name-message" reserve />);

    expect(row().className.split(' ')).not.toContain('min-h-5');
  });

  it('gives a reserved row holding a message its top margin', () => {
    render(<FieldMessage id="name-message" reserve error="Enter a valid email address" />);

    expect(row().className.split(' ')).toContain('mt-1');
  });

  it('gives a row holding a message its top margin', () => {
    render(<FieldMessage id="name-message" error="Enter a valid email address" />);

    expect(row().className.split(' ')).toContain('mt-1');
  });

  it('gives a row holding only a success line its top margin when the error is empty', () => {
    render(<FieldMessage id="name-message" error="" success="Looks good" />);

    expect(row().className.split(' ')).toContain('mt-1');
  });

  it('gives a row holding a message one line of height', () => {
    render(<FieldMessage id="name-message" error="Enter a valid email address" />);

    expect(row().className.split(' ')).toContain('min-h-5');
  });

  it('gives a row holding only a success line one line of height when the error is empty', () => {
    render(<FieldMessage id="name-message" error="" success="Looks good" />);

    expect(row().className.split(' ')).toContain('min-h-5');
  });

  it('announces an error as an alert inside the row', () => {
    render(<FieldMessage id="name-message" error="Enter a valid email address" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Enter a valid email address');
    expect(row()).toContainElement(alert);
  });

  it('draws an error in the destructive colour', () => {
    render(<FieldMessage id="name-message" error="Enter a valid email address" />);

    expect(screen.getByRole('alert').className.split(' ')).toContain('text-destructive');
  });

  it('shows a success line without an alert role', () => {
    render(<FieldMessage id="name-message" success="Username is available" />);

    expect(row()).toHaveTextContent('Username is available');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('draws a success line in the success colour', () => {
    render(<FieldMessage id="name-message" success="Username is available" />);

    expect(screen.getByText('Username is available').className.split(' ')).toContain(
      'text-success'
    );
  });

  it('shows the error when given both an error and a success line', () => {
    render(
      <FieldMessage
        id="name-message"
        error="Enter a valid email address"
        success="Username is available"
      />
    );

    expect(row()).toHaveTextContent('Enter a valid email address');
    expect(row()).not.toHaveTextContent('Username is available');
  });

  it('puts the error test id on the error line', () => {
    render(
      <FieldMessage
        id="name-message"
        error="Enter a valid email address"
        errorTestId="field-error"
      />
    );

    expect(screen.getByTestId('field-error')).toBe(screen.getByRole('alert'));
  });

  it('draws no error test id on a success line', () => {
    render(<FieldMessage id="name-message" success="Looks good" errorTestId="field-error" />);

    expect(screen.queryByTestId('field-error')).not.toBeInTheDocument();
  });

  it('draws no test id on the error line when given none', () => {
    render(<FieldMessage id="name-message" error="Enter a valid email address" />);

    expect(screen.getByRole('alert')).not.toHaveAttribute('data-testid');
  });
});
