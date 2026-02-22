import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Accordion } from './accordion';

describe('Accordion', () => {
  it('renders trigger text', () => {
    render(<Accordion trigger="Click me">Hidden content</Accordion>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('has data-slot attribute on container', () => {
    render(
      <Accordion trigger="Trigger" data-testid="accordion">
        Content
      </Accordion>
    );
    expect(screen.getByTestId('accordion')).toHaveAttribute('data-slot', 'accordion');
  });

  it('hides content by default', () => {
    render(<Accordion trigger="Trigger">Hidden content</Accordion>);
    expect(screen.queryByText('Hidden content')).not.toBeVisible();
  });

  it('shows content when defaultOpen is true', () => {
    render(
      <Accordion trigger="Trigger" defaultOpen>
        Visible content
      </Accordion>
    );
    expect(screen.getByText('Visible content')).toBeVisible();
  });

  it('toggles content on trigger click', async () => {
    const user = userEvent.setup();
    render(<Accordion trigger="Trigger">Toggle content</Accordion>);

    expect(screen.queryByText('Toggle content')).not.toBeVisible();

    await user.click(screen.getByText('Trigger'));
    expect(screen.getByText('Toggle content')).toBeVisible();

    await user.click(screen.getByText('Trigger'));
    expect(screen.queryByText('Toggle content')).not.toBeVisible();
  });

  it('applies custom className', () => {
    render(
      <Accordion trigger="Trigger" className="custom-class" data-testid="accordion">
        Content
      </Accordion>
    );
    expect(screen.getByTestId('accordion')).toHaveClass('custom-class');
  });

  it('trigger button has pointer cursor and hover background classes', () => {
    render(<Accordion trigger="Trigger">Content</Accordion>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('cursor-pointer');
    expect(button).toHaveClass('hover:bg-muted/50');
  });
});
