import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReplyingTo } from '@/components/chat/message/replying-to';

describe('ReplyingTo', () => {
  it('reads "replying to" followed by the name', () => {
    const { container } = render(<ReplyingTo name="Bob" />);

    expect(container).toHaveTextContent(/^replying to Bob$/);
  });

  it('sets the name in an element of its own', () => {
    const { container } = render(<ReplyingTo name="Bob" />);

    const name = screen.getByText('Bob');
    expect(name).not.toBe(container.firstElementChild);
    expect(name).toHaveTextContent(/^Bob$/);
  });

  it('truncates a long name rather than wrapping it', () => {
    render(<ReplyingTo name="Maximiliana Oyelaran-Whitcombe" />);

    expect(screen.getByText('Maximiliana Oyelaran-Whitcombe')).toHaveClass('truncate');
  });

  it('takes a line of its own on phones', () => {
    const { container } = render(<ReplyingTo name="Bob" />);

    expect(container.firstElementChild).toHaveClass('max-md:basis-full');
  });
});
