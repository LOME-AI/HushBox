import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import section from './button.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

function slotted(slot: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
}

describe('the button kit section', () => {
  it('is compared against catalog part 2', () => {
    expect(section.part).toBe(2);
  });

  it('is titled Buttons', () => {
    expect(section.title).toBe('Buttons');
  });

  it('draws every variant', () => {
    renderSection();
    const variants = new Set(slotted('button').map((element) => element.dataset['variant']));

    expect(variants).toEqual(
      new Set(['default', 'secondary', 'outline', 'ghost', 'link', 'destructive', 'bare'])
    );
  });

  it('draws every size', () => {
    renderSection();
    const sizes = new Set(slotted('button').map((element) => element.dataset['size']));

    expect(sizes).toEqual(new Set(['sm', 'default', 'lg', 'xl']));
  });

  it('draws every drawn variant disabled', () => {
    renderSection();
    const disabled = new Set(
      slotted('button')
        .filter((element) => element.hasAttribute('disabled'))
        .map((element) => element.dataset['variant'])
    );

    expect(disabled).toEqual(
      new Set(['default', 'secondary', 'outline', 'ghost', 'link', 'destructive'])
    );
  });

  it('draws an aria-disabled button', () => {
    renderSection();

    expect(
      slotted('button').some((element) => element.getAttribute('aria-disabled') === 'true')
    ).toBe(true);
  });

  it('draws a loading button', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Saving' })).toHaveAttribute('aria-busy', 'true');
  });

  it('draws every icon button size', () => {
    renderSection();
    const sizes = new Set(slotted('icon-button').map((element) => element.dataset['size']));

    expect(sizes).toEqual(new Set(['2xs', 'xs', 'sm', 'md', 'lg']));
  });

  it('draws an icon button that extends its target', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'More options' })).toHaveClass(
      'pointer-coarse:before:size-11'
    );
  });

  it('starts loading when the sample is pressed', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByRole('button', { name: 'Saving changes' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });

  it('returns the sample to idle', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await user.click(screen.getByRole('button', { name: 'Reset' }));

    expect(screen.getByRole('button', { name: 'Save changes' })).not.toHaveAttribute('aria-busy');
  });
});
