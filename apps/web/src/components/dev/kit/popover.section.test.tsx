import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import section from './popover.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

describe('popover kit section', () => {
  it('is compared against catalog part 6', () => {
    expect(section.part).toBe(6);
  });

  it('opens the reply popover named by its title', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'This reply' }));

    expect(await screen.findByRole('dialog')).toHaveAccessibleName('This reply');
  });

  it("draws the reply's cost in its popover", async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'This reply' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('$0.0118')).toBeInTheDocument();
  });

  it("draws the reply's label from 768", async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'This reply' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('This reply')).toHaveClass('md:block');
  });

  it("hides the reply's label below 768, where the sheet head carries the title", async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'This reply' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('This reply')).toHaveClass('hidden');
  });

  it("sets the reply's label at 600 and 0.875rem", async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'This reply' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('This reply')).toHaveClass('font-semibold', 'text-sm');
  });

  it('opens the facts popover with a fact line', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Storage' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Saved encrypted')).toBeInTheDocument();
  });

  it('opens the branches popover at 23rem', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Branches' }));

    expect(await screen.findByRole('dialog', { name: 'Branches' })).toHaveClass('w-92');
  });

  it('opens the aspect ratio popover at 25rem', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Aspect ratio' }));

    expect(await screen.findByRole('dialog', { name: 'Aspect ratio' })).toHaveClass('w-100');
  });

  it('holds every aspect ratio in its popover', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Aspect ratio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aspect ratio' });

    expect(within(dialog).getAllByRole('button')).toHaveLength(18);
  });

  it('opens the column popover inside its column', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'In the column' }));

    expect(await screen.findByRole('dialog', { name: 'Held in the column' })).toBeInTheDocument();
  });

  it('shows the long tooltip from its trigger', async () => {
    renderSection();

    await userEvent.hover(screen.getByRole('button', { name: 'Long tooltip' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'We only partner with AI providers that never store or train on your data.'
    );
  });
});
