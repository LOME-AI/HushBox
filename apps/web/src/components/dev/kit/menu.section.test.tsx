import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import section from './menu.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

async function open(name: string): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByRole('button', { name }));
  return screen.findByRole('menu');
}

describe('menu kit section', () => {
  it('is compared against catalog part 6', () => {
    expect(section.part).toBe(6);
  });

  it("opens the header's more options menu", async () => {
    renderSection();

    await open('More options');

    expect(screen.getByRole('menuitem', { name: 'Accessibility' })).toBeInTheDocument();
  });

  it('opens the account menu with its settings shortcut', async () => {
    renderSection();

    await open('Account');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveTextContent('Ctrl ,');
  });

  it("offers a conversation's delete in the danger tone", async () => {
    renderSection();

    await open('Conversation actions');

    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-destructive');
  });

  it('opens the effort menu as a radio group', async () => {
    renderSection();

    await open('Effort · Mid');

    expect(screen.getByRole('menuitemradio', { name: 'Mid' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('greys the refused effort rung and keeps its reason', async () => {
    renderSection();

    await open('Effort · Mid');

    expect(screen.getByRole('menuitemradio', { name: 'Max' })).toHaveAccessibleDescription(
      "This model can't write a long enough answer."
    );
  });

  it('opens the mode menu at its 12rem floor', async () => {
    renderSection();

    const menu = await open('Change mode');

    expect(menu).toHaveClass('min-w-48');
  });

  it('opens the locked mode menu with the refused image and its reason', async () => {
    renderSection();

    await open('Change mode, image locked');

    expect(screen.getByRole('menuitemradio', { name: 'Image' })).toHaveAccessibleDescription(
      'Add credit to unlock image generation'
    );
  });

  it('chooses a mode in the locked mode menu', async () => {
    renderSection();
    await open('Change mode, image locked');
    await userEvent.setup().click(screen.getByRole('menuitemradio', { name: 'Video' }));

    await open('Change mode, image locked');

    expect(screen.getByRole('menuitemradio', { name: 'Video' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('offers a link item that opens in this tab', async () => {
    renderSection();

    await open('Links');

    expect(screen.getByRole('menuitem', { name: 'About HushBox' })).toHaveAttribute(
      'href',
      '/welcome'
    );
  });

  it('offers a link item that opens in a new tab', async () => {
    renderSection();

    await open('Links');

    expect(screen.getByRole('menuitem', { name: 'GitHub' })).toHaveAttribute('target', '_blank');
  });

  it('offers a disabled link item that goes nowhere, with its reason', async () => {
    renderSection();

    await open('Links');

    expect(screen.getByRole('menuitem', { name: 'Database Studio' })).toHaveAccessibleDescription(
      'Opens only while developing locally'
    );
  });

  it("carries its caller's test id on a link item", async () => {
    renderSection();

    await open('Links');

    expect(screen.getByTestId(TEST_IDS.menuGithub)).toBe(
      screen.getByRole('menuitem', { name: 'GitHub' })
    );
  });

  it('closes a sample menu once its item is chosen', async () => {
    renderSection();
    await open('More options');

    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Accessibility' }));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('shows the chosen effort on its trigger', async () => {
    renderSection();
    await open('Effort · Mid');

    await userEvent.setup().click(screen.getByRole('menuitemradio', { name: 'High' }));

    expect(await screen.findByRole('button', { name: 'Effort · High' })).toBeInTheDocument();
  });

  it('marks the chosen mode checked', async () => {
    renderSection();
    await open('Change mode');
    await userEvent.setup().click(screen.getByRole('menuitemradio', { name: 'Video' }));

    await open('Change mode');

    expect(screen.getByRole('menuitemradio', { name: 'Video' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
