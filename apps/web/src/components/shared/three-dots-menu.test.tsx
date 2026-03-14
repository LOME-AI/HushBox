import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropdownMenuItem } from '@hushbox/ui';
import { ThreeDotsMenu } from './three-dots-menu';

describe('ThreeDotsMenu', () => {
  it('renders a trigger button with "More options" accessible label', () => {
    render(
      <ThreeDotsMenu>
        <DropdownMenuItem>Action</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    expect(screen.getByRole('button', { name: /more options/i })).toBeInTheDocument();
  });

  it('opens dropdown and renders children on click', async () => {
    const user = userEvent.setup();
    render(
      <ThreeDotsMenu>
        <DropdownMenuItem>Rename</DropdownMenuItem>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    await user.click(screen.getByRole('button', { name: /more options/i }));
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('forwards className to the trigger button', () => {
    render(
      <ThreeDotsMenu className="absolute right-1">
        <DropdownMenuItem>Action</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    const button = screen.getByRole('button', { name: /more options/i });
    expect(button.className).toContain('absolute');
    expect(button.className).toContain('right-1');
  });

  it('forwards data-testid to the trigger button', () => {
    render(
      <ThreeDotsMenu data-testid="my-menu">
        <DropdownMenuItem>Action</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    expect(screen.getByTestId('my-menu')).toBeInTheDocument();
  });

  it('forwards onClick to the trigger button', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(
      <ThreeDotsMenu onClick={handleClick}>
        <DropdownMenuItem>Action</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    await user.click(screen.getByRole('button', { name: /more options/i }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('uses align="end" by default', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ThreeDotsMenu>
        <DropdownMenuItem>Action</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    await user.click(screen.getByRole('button', { name: /more options/i }));
    const content = container.ownerDocument.querySelector('[role="menu"]');
    expect(content).toBeInTheDocument();
  });

  it('accepts a custom align prop', async () => {
    const user = userEvent.setup();
    render(
      <ThreeDotsMenu align="start">
        <DropdownMenuItem>Action</DropdownMenuItem>
      </ThreeDotsMenu>
    );
    await user.click(screen.getByRole('button', { name: /more options/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
