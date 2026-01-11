import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BudgetMessages } from './budget-messages';
import type { BudgetError } from '@lome-chat/shared';

describe('BudgetMessages', () => {
  describe('rendering', () => {
    it('renders nothing when errors array is empty', () => {
      const { container } = render(<BudgetMessages errors={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders single error message', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test error message' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('renders multiple error messages', () => {
      const errors: BudgetError[] = [
        { id: 'error1', type: 'error', message: 'First error' },
        { id: 'error2', type: 'warning', message: 'Second warning' },
        { id: 'info1', type: 'info', message: 'Info message' },
      ];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText('First error')).toBeInTheDocument();
      expect(screen.getByText('Second warning')).toBeInTheDocument();
      expect(screen.getByText('Info message')).toBeInTheDocument();
    });

    it('renders container with testid', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByTestId('budget-messages')).toBeInTheDocument();
    });
  });

  describe('accessible styling (neutral bg + colored border + colored icon)', () => {
    it('all message types have neutral background and neutral text', () => {
      const errors: BudgetError[] = [
        { id: 'error1', type: 'error', message: 'Error' },
        { id: 'warn1', type: 'warning', message: 'Warning' },
        { id: 'info1', type: 'info', message: 'Info' },
      ];
      render(<BudgetMessages errors={errors} />);

      const errorMsg = screen.getByTestId('budget-message-error1');
      const warnMsg = screen.getByTestId('budget-message-warn1');
      const infoMsg = screen.getByTestId('budget-message-info1');

      // All have neutral background
      expect(errorMsg).toHaveClass('bg-muted/50');
      expect(warnMsg).toHaveClass('bg-muted/50');
      expect(infoMsg).toHaveClass('bg-muted/50');

      // All have neutral text
      expect(errorMsg).toHaveClass('text-foreground');
      expect(warnMsg).toHaveClass('text-foreground');
      expect(infoMsg).toHaveClass('text-foreground');
    });

    it('error type has red left border', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error message' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('border-l-3');
      expect(message).toHaveClass('border-l-destructive');
    });

    it('warning type has yellow left border', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'warning', message: 'Warning message' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('border-l-3');
      expect(message).toHaveClass('border-l-yellow-500');
    });

    it('info type has blue left border', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Info message' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('border-l-3');
      expect(message).toHaveClass('border-l-blue-500');
    });

    it('error icon has red color', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toHaveClass('text-destructive');
    });

    it('warning icon has yellow color', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'warning', message: 'Warning' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toHaveClass('text-yellow-500');
    });

    it('info icon has blue color', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Info' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toHaveClass('text-blue-500');
    });
  });

  describe('icons', () => {
    it('shows AlertTriangle icon for error type', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error message' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toBeInTheDocument();
    });

    it('shows AlertTriangle icon for warning type', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'warning', message: 'Warning message' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toBeInTheDocument();
    });

    it('shows Info icon for info type', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Info message' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('stacks messages vertically with gap', () => {
      const errors: BudgetError[] = [
        { id: 'error1', type: 'error', message: 'First' },
        { id: 'error2', type: 'warning', message: 'Second' },
      ];
      render(<BudgetMessages errors={errors} />);

      const container = screen.getByTestId('budget-messages');
      expect(container).toHaveClass('flex');
      expect(container).toHaveClass('flex-col');
      expect(container).toHaveClass('gap-2');
    });

    it('message has flex layout with icon and text', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('flex');
      expect(message).toHaveClass('items-center');
      expect(message).toHaveClass('gap-2');
    });

    it('message has rounded corners and padding', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('rounded');
      expect(message).toHaveClass('px-3');
      expect(message).toHaveClass('py-2');
    });
  });

  describe('accessibility', () => {
    it('uses appropriate role for alerts', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveAttribute('role', 'alert');
    });
  });

  describe('custom className', () => {
    it('accepts custom className on container', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} className="custom-class" />);

      const container = screen.getByTestId('budget-messages');
      expect(container).toHaveClass('custom-class');
    });
  });
});
