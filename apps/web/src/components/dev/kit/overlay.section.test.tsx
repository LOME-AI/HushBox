import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import section from './overlay.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

describe('overlay kit section', () => {
  it('is compared against catalog part 6', () => {
    expect(section.part).toBe(6);
  });

  it('opens the change-password overlay from its button', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Change Password');
  });

  it('draws both password fields inside the overlay', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog');

    expect(dialog).toContainElement(screen.getByLabelText('Current password'));
    expect(dialog).toContainElement(screen.getByLabelText('New password'));
  });

  it('closes the overlay from Cancel', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('closes the overlay from its confirm button', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('lays the change-password actions out in the overlay footer row', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog');

    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel.parentElement).toHaveClass('hb-button-group');
  });

  it('opens a stepped dialog whose header counts the step', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Stepped dialog' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Step 1 of 3')).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('Save your recovery phrase');
  });

  it('opens a dialog with a centred head', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Centred head' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveClass('text-title-1');
  });

  it('opens a top-placed dialog', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Top placement' }));

    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Jump to');
  });

  it('opens a confirmation as an alert dialog', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Alert dialog' }));

    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName('Delete conversation?');
  });
});
