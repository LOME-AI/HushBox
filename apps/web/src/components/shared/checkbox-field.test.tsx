import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CheckboxField } from './checkbox-field';

vi.mock('@hushbox/ui', () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
    className,
    ...rest
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean | 'indeterminate') => void;
    className?: string;
  } & Record<string, unknown>) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onCheckedChange?.(e.target.checked)}
      className={className}
      {...rest}
    />
  ),
}));

describe('CheckboxField', () => {
  const defaultProps = {
    id: 'test-checkbox',
    checked: false,
    onCheckedChange: vi.fn(),
    label: 'Accept terms',
  };

  it('renders a checkbox with the given id', () => {
    render(<CheckboxField {...defaultProps} />);

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute('id', 'test-checkbox');
  });

  it('renders a label linked to the checkbox', () => {
    render(<CheckboxField {...defaultProps} />);

    const label = screen.getByText('Accept terms');
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', 'test-checkbox');
  });

  it('displays checked state when checked is true', () => {
    render(<CheckboxField {...defaultProps} checked={true} />);

    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('displays unchecked state when checked is false', () => {
    render(<CheckboxField {...defaultProps} checked={false} />);

    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('calls onCheckedChange with true when clicked while unchecked', async () => {
    const onCheckedChange = vi.fn();
    render(<CheckboxField {...defaultProps} onCheckedChange={onCheckedChange} />);

    await userEvent.click(screen.getByRole('checkbox'));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('calls onCheckedChange with boolean cast (val === true)', async () => {
    const onCheckedChange = vi.fn();
    render(<CheckboxField {...defaultProps} checked={true} onCheckedChange={onCheckedChange} />);

    await userEvent.click(screen.getByRole('checkbox'));

    // Should cast to boolean, not pass indeterminate
    expect(onCheckedChange).toHaveBeenCalledWith(false);
    expect(typeof onCheckedChange.mock.calls[0]![0]).toBe('boolean');
  });

  it('applies label styling from login.tsx pattern', () => {
    render(<CheckboxField {...defaultProps} />);

    const label = screen.getByText('Accept terms');
    expect(label).toHaveClass('text-muted-foreground');
    expect(label).toHaveClass('cursor-pointer');
    expect(label).toHaveClass('text-sm');
    expect(label).toHaveClass('select-none');
  });

  it('applies checkbox sizing from login.tsx pattern', () => {
    render(<CheckboxField {...defaultProps} />);

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveClass('size-6');
    expect(checkbox).toHaveClass('-mt-px');
  });

  it('does not render description when not provided', () => {
    render(<CheckboxField {...defaultProps} />);

    const paragraphs = screen.queryAllByText(/.+/);
    const descriptionP = paragraphs.filter((el) => el.tagName === 'P');
    expect(descriptionP).toHaveLength(0);
  });

  it('renders description when provided', () => {
    render(<CheckboxField {...defaultProps} description="Only messages from now on" />);

    const description = screen.getByText('Only messages from now on');
    expect(description.tagName).toBe('P');
    expect(description).toHaveClass('text-muted-foreground');
    expect(description).toHaveClass('text-xs');
  });

  it('does not add data-testid when testId is not provided', () => {
    const { container } = render(<CheckboxField {...defaultProps} />);

    const wrapper = container.firstElementChild;
    expect(wrapper).not.toHaveAttribute('data-testid');
  });

  it('adds data-testid when testId is provided', () => {
    render(<CheckboxField {...defaultProps} testId="my-field" />);

    expect(screen.getByTestId('my-field')).toBeInTheDocument();
  });

  it('wraps checkbox and label in a flex container', () => {
    render(<CheckboxField {...defaultProps} />);

    const checkbox = screen.getByRole('checkbox');
    const container = checkbox.parentElement;
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('items-center');
    expect(container).toHaveClass('gap-2');
  });

  it('wraps description as sibling of label inside a shared wrapper', () => {
    render(<CheckboxField {...defaultProps} description="Helpful note" />);

    const label = screen.getByText('Accept terms');
    const description = screen.getByText('Helpful note');
    // Both should share the same parent wrapper (indents description under label)
    expect(label.parentElement).toBe(description.parentElement);
  });
});
