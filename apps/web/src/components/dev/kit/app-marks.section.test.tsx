import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import section from './app-marks.section';

function renderSection(): HTMLElement {
  return render(<>{section.render()}</>).container;
}

function sample(container: HTMLElement, name: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-sample="${name}"]`);
  if (element === null) throw new Error(`no ${name} sample`);
  return element;
}

describe('the app marks kit section', () => {
  it('is compared against catalog part 4', () => {
    expect(section.part).toBe(4);
  });

  it('is titled for the marks it draws', () => {
    expect(section.title).toBe('Chips, avatars and trust lines');
  });

  it('draws the icon-only mode chip', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Change mode' })).toBeInTheDocument();
  });

  it.each([
    ['pressed', 'aria-pressed', 'true'],
    ['unpressed', 'aria-pressed', 'false'],
    ['disabled', 'aria-disabled', 'true'],
    ['expanded', 'aria-expanded', 'true'],
  ])('draws the %s chip', (name, attribute, value) => {
    const container = renderSection();

    expect(within(sample(container, `chip-${name}`)).getByRole('button')).toHaveAttribute(
      attribute,
      value
    );
  });

  it('draws the model chip with its picker open', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Model: GPT-5' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('draws a model chip whose name runs past 18ch', () => {
    const container = renderSection();

    expect(
      within(sample(container, 'model-truncate')).getByRole('button').textContent.length
    ).toBeGreaterThan(18);
  });

  it('draws a model chip with a short name inside a compact composer', () => {
    const container = renderSection();

    const compact = sample(container, 'model-compact');
    expect(compact).toHaveClass('@container/composer');
    expect(within(compact).getByText('Flash')).toBeInTheDocument();
  });

  it('draws an online, an offline and a person avatar', () => {
    const container = renderSection();

    const avatars = sample(container, 'avatars').querySelectorAll('[data-slot="avatar"]');
    expect(avatars).toHaveLength(3);
    expect(avatars[0]).toHaveAttribute('data-online');
    expect(avatars[1]).not.toHaveAttribute('data-online');
    expect(avatars[2]?.querySelector('svg')).not.toBeNull();
  });

  it('draws a facepile that fits and one that counts the rest', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Members (3)' })).not.toHaveTextContent('+');
    expect(screen.getByRole('button', { name: 'Members (5)' })).toHaveTextContent('+2');
  });

  it.each(['trust-start', 'trust-center', 'trust-wrapped'])('draws the %s trust line', (name) => {
    const container = renderSection();

    expect(sample(container, name).querySelector('p svg')).not.toBeNull();
  });

  it('draws a trust line in the small ui size', () => {
    const container = renderSection();

    expect(sample(container, 'trust-ui-sm').querySelector('p')).toHaveClass('text-ui-sm');
  });

  it('centres the centred trust line', () => {
    const container = renderSection();

    expect(sample(container, 'trust-center').querySelector('p')).toHaveClass('text-center');
  });

  it('leaves its samples as drawn when they are clicked', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Model: GPT-5' }));
    await userEvent.click(screen.getByRole('button', { name: 'Members (5)' }));

    expect(screen.getByRole('button', { name: 'Model: GPT-5' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});
