import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SandboxBadge } from './sandbox-badge';

describe('SandboxBadge', () => {
  it('says the document cannot reach the account', () => {
    render(<SandboxBadge />);

    expect(screen.getByText("Sandboxed. It can't reach your account.")).toBeInTheDocument();
  });

  it('leads with a green shield the reader is not asked to read', () => {
    const { container } = render(<SandboxBadge />);

    const shield = container.querySelector('svg');
    expect(shield).toHaveAttribute('aria-hidden', 'true');
    expect(shield).toHaveClass('text-success');
  });
});
