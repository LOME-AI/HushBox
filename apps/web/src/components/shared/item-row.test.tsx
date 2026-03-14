import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemRow } from './item-row';

describe('ItemRow', () => {
  it('renders children', () => {
    render(
      <ItemRow menuContent={<div>menu</div>}>
        <span>child content</span>
      </ItemRow>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('renders ThreeDotsMenu with menuContent', async () => {
    const user = userEvent.setup();
    render(
      <ItemRow menuContent={<div role="menuitem">Rename</div>}>
        <span>content</span>
      </ItemRow>
    );
    const menuButton = screen.getByRole('button', { name: /more options/i });
    expect(menuButton).toBeInTheDocument();
    await user.click(menuButton);
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
  });

  it('hides ThreeDotsMenu when showMenu is false', () => {
    render(
      <ItemRow menuContent={<div>menu</div>} showMenu={false}>
        <span>content</span>
      </ItemRow>
    );
    expect(screen.queryByRole('button', { name: /more options/i })).not.toBeInTheDocument();
  });

  it('shows ThreeDotsMenu by default', () => {
    render(
      <ItemRow menuContent={<div>menu</div>}>
        <span>content</span>
      </ItemRow>
    );
    expect(screen.getByRole('button', { name: /more options/i })).toBeInTheDocument();
  });

  it('applies className to the container', () => {
    render(
      <ItemRow menuContent={<div>menu</div>} className="bg-accent shrink-0">
        <span>content</span>
      </ItemRow>
    );
    const container = screen.getByText('content').parentElement!;
    expect(container.className).toContain('bg-accent');
    expect(container.className).toContain('shrink-0');
  });

  it('has base structural classes on the container', () => {
    render(
      <ItemRow menuContent={<div>menu</div>}>
        <span>content</span>
      </ItemRow>
    );
    const container = screen.getByText('content').parentElement!;
    expect(container.className).toContain('group');
    expect(container.className).toContain('relative');
    expect(container.className).toContain('flex');
    expect(container.className).toContain('items-center');
    expect(container.className).toContain('overflow-hidden');
    expect(container.className).toContain('rounded-md');
    expect(container.className).toContain('transition-colors');
  });

  it('forwards data-testid to the container', () => {
    render(
      <ItemRow menuContent={<div>menu</div>} data-testid="my-row">
        <span>content</span>
      </ItemRow>
    );
    expect(screen.getByTestId('my-row')).toBeInTheDocument();
  });

  it('forwards menuProps.align to ThreeDotsMenu', async () => {
    const user = userEvent.setup();
    render(
      <ItemRow menuContent={<div role="menuitem">action</div>} menuProps={{ align: 'start' }}>
        <span>content</span>
      </ItemRow>
    );
    await user.click(screen.getByRole('button', { name: /more options/i }));
    expect(screen.getByRole('menuitem', { name: /action/i })).toBeInTheDocument();
  });

  it('forwards menuProps.className to ThreeDotsMenu trigger', () => {
    render(
      <ItemRow menuContent={<div>menu</div>} menuProps={{ className: 'absolute right-1' }}>
        <span>content</span>
      </ItemRow>
    );
    const menuButton = screen.getByRole('button', { name: /more options/i });
    expect(menuButton.className).toContain('absolute');
    expect(menuButton.className).toContain('right-1');
  });

  it('forwards menuProps.data-testid to ThreeDotsMenu trigger', () => {
    render(
      <ItemRow menuContent={<div>menu</div>} menuProps={{ 'data-testid': 'row-menu' }}>
        <span>content</span>
      </ItemRow>
    );
    expect(screen.getByTestId('row-menu')).toBeInTheDocument();
  });

  it('forwards menuProps.onClick to ThreeDotsMenu trigger', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ItemRow menuContent={<div>menu</div>} menuProps={{ onClick }}>
        <span>content</span>
      </ItemRow>
    );
    await user.click(screen.getByRole('button', { name: /more options/i }));
    expect(onClick).toHaveBeenCalled();
  });

  it('renders without menuProps', () => {
    render(
      <ItemRow menuContent={<div>menu</div>}>
        <span>content</span>
      </ItemRow>
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more options/i })).toBeInTheDocument();
  });

});
