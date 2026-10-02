import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { ResendFeedback } from './resend-feedback';

describe('ResendFeedback', () => {
  it('renders nothing before any send', () => {
    const { container } = render(<ResendFeedback feedback={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a confirmation in the success colour', () => {
    render(<ResendFeedback feedback={{ message: 'Verification email sent.', isError: false }} />);

    const line = screen.getByTestId(TEST_IDS.resendFeedback);
    expect(line).toHaveTextContent('✓ Verification email sent.');
    expect(line).toHaveClass('text-success');
  });

  it('shows a refusal in the destructive colour', () => {
    render(<ResendFeedback feedback={{ message: 'Rate limited', isError: true }} />);

    const line = screen.getByTestId(TEST_IDS.resendFeedback);
    expect(line).toHaveTextContent('✗ Rate limited');
    expect(line).toHaveClass('text-destructive');
  });

  it('announces the line in a polite live region', () => {
    render(<ResendFeedback feedback={{ message: 'Verification email sent.', isError: false }} />);

    const line = screen.getByTestId(TEST_IDS.resendFeedback);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
  });

  it('hides the glyph from the accessibility tree', () => {
    render(<ResendFeedback feedback={{ message: 'Rate limited', isError: true }} />);

    const line = screen.getByTestId(TEST_IDS.resendFeedback);
    expect(within(line).getByText('✗')).toHaveAttribute('aria-hidden', 'true');
  });

  it('sets the line small and centred under the button', () => {
    render(<ResendFeedback feedback={{ message: 'Verification email sent.', isError: false }} />);

    expect(screen.getByTestId(TEST_IDS.resendFeedback)).toHaveClass(
      'mt-3',
      'text-center',
      'text-sm'
    );
  });
});
