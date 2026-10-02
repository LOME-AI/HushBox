import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  Textarea,
  TEXTAREA_MIRROR_CLASSES,
  TEXTAREA_TYPE_SCALE_CLASSES,
  TEXTAREA_WRAP_CLASSES,
} from './textarea';

describe('Textarea', () => {
  it('renders textarea element', () => {
    render(<Textarea />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders with placeholder', () => {
    render(<Textarea placeholder="Enter message" />);
    expect(screen.getByPlaceholderText('Enter message')).toBeInTheDocument();
  });

  it('accepts user input', async () => {
    const user = userEvent.setup();
    render(<Textarea />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello World');
    expect(textarea).toHaveValue('Hello World');
  });

  it('calls onChange when value changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Textarea onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'a');
    expect(onChange).toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Textarea disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('does not accept input when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Textarea disabled onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'test');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies custom className', () => {
    render(<Textarea className="custom-class" />);
    expect(screen.getByRole('textbox')).toHaveClass('custom-class');
  });

  it('forwards ref to textarea element', () => {
    const ref = vi.fn();
    render(<Textarea ref={ref} />);
    expect(ref).toHaveBeenCalled();
  });

  it('has data-slot attribute', () => {
    render(<Textarea />);
    expect(screen.getByRole('textbox')).toHaveAttribute('data-slot', 'textarea');
  });

  it('accepts defaultValue', () => {
    render(<Textarea defaultValue="initial content" />);
    expect(screen.getByRole('textbox')).toHaveValue('initial content');
  });

  it('accepts controlled value', () => {
    render(<Textarea value="controlled" onChange={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('controlled');
  });

  it('accepts name attribute', () => {
    render(<Textarea name="message" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('name', 'message');
  });

  it('accepts required attribute', () => {
    render(<Textarea required />);
    expect(screen.getByRole('textbox')).toBeRequired();
  });

  it('accepts rows attribute', () => {
    render(<Textarea rows={5} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '5');
  });

  it('carries the box metrics it publishes for a mirror overlay', () => {
    render(<Textarea />);
    expect(screen.getByRole('textbox')).toHaveClass(...TEXTAREA_MIRROR_CLASSES.split(' '));
  });

  it('publishes the mirror metrics as the type scale plus the padding', () => {
    const typeScale = new Set(TEXTAREA_TYPE_SCALE_CLASSES.split(' '));
    expect(TEXTAREA_MIRROR_CLASSES.split(' ').filter((name) => !typeScale.has(name))).toEqual([
      'px-3',
      'py-2',
    ]);
  });

  it('handles multiline input', async () => {
    const user = userEvent.setup();
    render(<Textarea />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Line 1{enter}Line 2');
    expect(textarea).toHaveValue('Line 1\nLine 2');
  });

  it('does not rely on field-sizing-content for auto-grow', () => {
    render(<Textarea />);
    expect(screen.getByRole('textbox')).not.toHaveClass('field-sizing-content');
  });

  it('renders an aria-hidden sizing replica alongside the textarea', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica).not.toBeNull();
  });

  it('renders the replica with a trailing space so a final newline still grows a row', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica).toHaveTextContent(/hello/);
    expect(replica?.textContent).toBe('hello ');
  });

  it('gives the replica the same mirror classes as the textarea', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica).toHaveClass(...TEXTAREA_MIRROR_CLASSES.split(' '));
  });

  it('gives the replica the wrap classes so it wraps the way a textarea natively does', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica).toHaveClass(...TEXTAREA_WRAP_CLASSES.split(' '));
  });

  it('lets the replica break an unbroken string anywhere, so the string cannot set its width', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica).toHaveClass('wrap-anywhere');
  });

  it('gives the replica a caller-supplied className so a min/max-height override sizes it too', () => {
    const { container } = render(
      <Textarea value="hello" onChange={vi.fn()} className="max-h-72 min-h-32" />
    );
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica).toHaveClass('max-h-72', 'min-h-32');
  });

  it('does not put the caller className on the wrapper', () => {
    const { container } = render(<Textarea className="custom-class" />);
    const wrapper = container.firstElementChild;
    expect(wrapper).not.toHaveClass('custom-class');
  });

  it('gives the replica the same border the textarea carries', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const textarea = screen.getByRole('textbox');
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(textarea).toHaveClass('border');
    expect(replica).toHaveClass('border');
  });

  it('lets a caller zero the border on both the textarea and the replica', () => {
    const { container } = render(
      <Textarea value="hello" onChange={vi.fn()} className="border-0" />
    );
    const textarea = screen.getByRole('textbox');
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(textarea).toHaveClass('border-0');
    expect(textarea).not.toHaveClass('border');
    expect(replica).toHaveClass('border-0');
    expect(replica).not.toHaveClass('border');
  });

  it('sizes the replica from a caller-supplied sizingValue rather than the textarea value', () => {
    const { container } = render(
      <Textarea value="hello" sizingValue="hello world" onChange={vi.fn()} />
    );
    const textarea = screen.getByRole('textbox');
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(textarea).toHaveValue('hello');
    expect(replica?.textContent).toBe('hello world ');
  });

  it('falls back to the textarea value when no sizingValue is supplied', () => {
    const { container } = render(<Textarea value="hello" onChange={vi.fn()} />);
    const replica = container.querySelector('[aria-hidden="true"]');
    expect(replica?.textContent).toBe('hello ');
  });

  it('still resolves ref to the real textarea element, not the wrapper', () => {
    let node: HTMLTextAreaElement | null = null;
    render(
      <Textarea
        ref={(el) => {
          node = el;
        }}
      />
    );
    expect(node).toBeInstanceOf(HTMLTextAreaElement);
  });
});
