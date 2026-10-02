import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import section from './choices.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

describe('the choices kit section', () => {
  it('is compared against catalog part 3', () => {
    expect(section.part).toBe(3);
  });

  it('is titled Choices', () => {
    expect(section.title).toBe('Choices');
  });

  it('draws the checkbox at its one-line, two-line and three-line label lengths', () => {
    renderSection();

    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(3);
  });

  it('draws the large checkbox', () => {
    renderSection();

    expect(screen.getByRole('checkbox', { name: 'Keep me signed in' })).toBeInTheDocument();
  });

  it('toggles a checkbox from its label', async () => {
    const user = userEvent.setup();
    renderSection();
    const box = screen.getByRole('checkbox', { name: 'Keep me signed in' });

    await user.click(screen.getByText('Keep me signed in'));

    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  it('draws a switch row with its description', () => {
    renderSection();

    expect(screen.getByRole('switch', { name: 'Email notifications' })).toHaveAccessibleDescription(
      'A message when a long reply finishes or a member joins.'
    );
  });

  it('toggles a switch from its label', async () => {
    const user = userEvent.setup();
    renderSection();
    const control = screen.getByRole('switch', { name: 'Email notifications' });
    const before = control.getAttribute('aria-checked');

    await user.click(screen.getByText('Email notifications'));

    expect(control.getAttribute('aria-checked')).not.toBe(before);
  });

  it('draws the radio group under its legend', () => {
    renderSection();

    expect(screen.getByRole('radiogroup', { name: 'Budget period' })).toBeInTheDocument();
  });

  it('draws the counted textarea', () => {
    renderSection();

    expect(screen.getByText('203 / 5,000')).toBeInTheDocument();
  });

  it('draws a textarea over its limit', () => {
    renderSection();

    expect(screen.getByText('Only the first 40 characters will be used.')).toBeInTheDocument();
  });

  it('draws the select field', () => {
    renderSection();

    expect(screen.getByRole('combobox', { name: 'Font' })).toBeInTheDocument();
  });

  it('draws the toggle group with one part pressed', () => {
    renderSection();

    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveAttribute('data-state', 'on');
  });

  it('counts what is typed into the counted textarea', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByRole('textbox', { name: 'What should every model know?' }), '!');

    expect(screen.getByText('204 / 5,000')).toBeInTheDocument();
  });

  it('drops the notice once the over-limit text is cut back to the limit', async () => {
    const user = userEvent.setup();
    renderSection();
    const feedback = screen.getByRole('textbox', { name: 'Feedback' });

    await user.clear(feedback);
    await user.type(feedback, 'Short.');

    // The notice fades out before it leaves the page.
    await waitFor(() => {
      expect(screen.queryByText('Only the first 40 characters will be used.')).toBeNull();
    });
  });

  it('presses the toggle part that is clicked', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('radio', { name: 'Idea' }));

    expect(screen.getByRole('radio', { name: 'Idea' })).toHaveAttribute('data-state', 'on');
  });
});
