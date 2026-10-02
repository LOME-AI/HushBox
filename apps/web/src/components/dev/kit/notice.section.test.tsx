import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import section from './notice.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

function noticeWith(text: string): HTMLElement {
  const notice = screen.getByText(text).closest<HTMLElement>('[data-slot="notice"]');
  if (notice === null) throw new Error(`no notice holds "${text}"`);
  return notice;
}

async function openDialog(
  label: string,
  role: 'dialog' | 'alertdialog' = 'dialog'
): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: label }));
  return await screen.findByRole(role);
}

describe('notice kit section', () => {
  it('is compared against catalog part 5', () => {
    expect(section.part).toBe(5);
  });

  it('is titled Notices', () => {
    expect(section.title).toBe('Notices');
  });

  it('draws the composer stack in the composer placement', () => {
    renderSection();

    expect(noticeWith("Your balance can't cover this message.")).toHaveAttribute(
      'data-placement',
      'composer'
    );
  });

  it('keeps a blocking composer notice without a dismiss', () => {
    renderSection();

    const notice = noticeWith("Your balance can't cover this message.");
    expect(within(notice).queryByRole('button')).not.toBeInTheDocument();
  });

  it('removes a composer notice when it is dismissed', async () => {
    renderSection();
    const notice = noticeWith('Your balance is running low, so replies may be shortened.');

    await userEvent.click(within(notice).getByRole('button', { name: 'Dismiss notification' }));

    expect(
      screen.queryByText('Your balance is running low, so replies may be shortened.')
    ).not.toBeInTheDocument();
  });

  it('draws a failed turn as a tile with Regenerate', () => {
    renderSection();

    const tile = noticeWith('This service is temporarily unavailable.');
    expect(tile).toHaveAttribute('data-placement', 'tile');
    expect(within(tile).getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it("draws a failed model's slot with Copy in the corner", () => {
    renderSection();

    const slot = noticeWith('This model stopped before it finished answering.');
    expect(slot).toHaveAttribute('data-placement', 'slot');
    expect(within(slot).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it("draws the usage chart's error as a destructive subtle alert outside a dialog", () => {
    renderSection();

    const notice = noticeWith("Couldn't load this chart");
    expect(notice).toHaveClass('text-destructive');
    expect(notice).not.toHaveClass('bg-destructive/10');
  });

  it('draws the leave warning as a strong alert in its dialog', async () => {
    renderSection();

    const dialog = await openDialog('Leave conversation', 'alertdialog');

    expect(
      within(dialog)
        .getByText('As the owner, leaving will delete all messages and remove all members.')
        .closest('[data-slot="notice"]')
    ).toHaveClass('bg-muted');
  });

  it('draws the member limit as a destructive alert in its dialog', async () => {
    renderSection();

    const dialog = await openDialog('Add member');

    expect(
      within(dialog)
        .getByText('This conversation has reached the maximum of 100 members.')
        .closest('[data-slot="notice"]')
    ).toHaveAttribute('role', 'alert');
  });

  it("draws the share dialog's two notes with success icons", async () => {
    renderSection();

    const dialog = await openDialog('Share message');

    const notes = within(dialog).getAllByRole('status');
    expect(notes.map((note) => note.querySelector('svg.text-success'))).not.toContain(null);
  });

  it('closes a dialog from Cancel', async () => {
    renderSection();
    await openDialog('Remove member', 'alertdialog');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});
