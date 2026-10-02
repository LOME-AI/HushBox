import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import settingsRowsSection from './settings-rows.section';

function renderTwice(): void {
  // The kit draws every section in a light and a dark island.
  render(
    <>
      <div data-island="light">{settingsRowsSection.render()}</div>
      <div data-island="dark">{settingsRowsSection.render()}</div>
    </>
  );
}

function renderOnce(): void {
  render(<>{settingsRowsSection.render()}</>);
}

describe('the Settings rows kit section', () => {
  it('is titled Settings rows under the settings catalog part', () => {
    expect(settingsRowsSection.title).toBe('Settings rows');
    expect(settingsRowsSection.part).toBe(5);
  });

  it('shows the attention tone with inline actions', () => {
    renderOnce();
    const attention = screen.getByRole('region', { name: 'Needs attention' });

    expect(within(attention).getByRole('button', { name: 'Save phrase' })).toBeInTheDocument();
    expect(within(attention).getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    expect(attention.querySelector(String.raw`.md\:flex-none`)).not.toBeNull();
  });

  it('shows the danger tone with a stacked action', () => {
    renderOnce();
    const danger = screen.getByRole('region', { name: 'Danger zone' });
    const button = within(danger).getByRole('button', { name: 'Delete Account' });

    expect(button.parentElement).not.toHaveClass('md:flex-none');
  });

  it('shows value rows with a badge and a plain value', () => {
    renderOnce();
    const account = screen.getByRole('region', { name: 'Account' });

    expect(within(account).getByText('Verified')).toBeInTheDocument();
    expect(within(account).getByText('alice')).toBeInTheDocument();
  });

  it('sets the plain value at the UI size, as the reference draws the username', () => {
    renderOnce();
    const account = screen.getByRole('region', { name: 'Account' });

    expect(within(account).getByText('alice')).toHaveClass('text-ui');
  });

  it('shows navigate rows that press', async () => {
    renderOnce();
    const security = screen.getByRole('region', { name: 'Security' });
    const row = within(security).getByRole('button', { name: 'Two-Factor Authentication' });

    await userEvent.click(row);

    expect(row).toHaveAccessibleDescription('Manage your authentication security Enabled');
  });

  it('shows toggle rows that switch', async () => {
    renderOnce();
    const sound = screen.getByRole('switch', { name: 'Sound' });

    await userEvent.click(sound);

    expect(sound).toBeChecked();
  });

  it('shows external link rows that press', async () => {
    renderOnce();
    const legal = screen.getByRole('region', { name: 'Legal' });
    const terms = within(legal).getByRole('link', { name: 'Terms of Service' });

    await userEvent.click(terms);

    expect(terms.querySelector('svg')).not.toBeNull();
  });

  it('presses the action buttons without leaving the kit', async () => {
    renderOnce();

    for (const name of ['Save phrase', 'Turn on', 'Delete Account']) {
      await userEvent.click(screen.getByRole('button', { name }));
    }

    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument();
  });

  it('gives each island its own group ids', () => {
    renderTwice();
    const ids = [...document.querySelectorAll('section[id]')].map((section) => section.id);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
