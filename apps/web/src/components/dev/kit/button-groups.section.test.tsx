import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { buttonRowClass, buttonStackClass } from '@hushbox/ui/button-groups';
import section from './button-groups.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

/** The space a sample is drawn in, found by its caption. */
function space(caption: string): HTMLElement {
  const figure = screen.getByText(caption).closest('figure');
  const frame = figure?.querySelector<HTMLElement>('[data-space]');
  if (frame === null || frame === undefined) throw new Error(`no space under "${caption}"`);
  return frame;
}

function group(caption: string): HTMLElement {
  const root = space(caption).firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error(`no group under "${caption}"`);
  return root;
}

describe('the button groups kit section', () => {
  it('is compared against catalog part 2', () => {
    expect(section.part).toBe(2);
  });

  it('is titled Button groups', () => {
    expect(section.title).toBe('Button groups');
  });

  it.each([
    ['two buttons in 17rem', '17rem'],
    ['two buttons in 35rem', '35rem'],
    ['two buttons in 50rem', '50rem'],
    ['three buttons in 27rem', '27rem'],
    ['three buttons in 35rem', '35rem'],
  ])('draws a row of %s in a space that wide', (caption, width) => {
    renderSection();

    expect(space(caption).dataset['space']).toBe(width);
    expect(group(caption).className).toBe(buttonRowClass);
  });

  it.each([
    ['a stack in 35rem', '35rem'],
    ['a stack in 50rem', '50rem'],
  ])('draws %s in a space that wide', (caption, width) => {
    renderSection();

    expect(space(caption).dataset['space']).toBe(width);
    expect(group(caption).className).toBe(buttonStackClass);
  });

  it('draws the billing pair in a space where its labels stack', () => {
    renderSection();

    const buttons = within(group('the billing pair in 18rem')).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toContain('Return to the app');
  });

  it('draws short labels by the label rule in 18rem', () => {
    renderSection();

    expect(space('short labels in 18rem').dataset['space']).toBe('18rem');
  });

  it('draws an icon button inside a row', () => {
    renderSection();

    expect(
      within(group('an icon button in a row')).getByRole('button', { name: 'More options' })
    ).toBeInTheDocument();
  });

  it.each([
    ['a lone block button in 35rem', '35rem'],
    ['a lone block button in 50rem', '50rem'],
    ['a lone block button with a long label in 50rem', '50rem'],
  ])('draws %s as the only thing in a space that wide', (caption, width) => {
    renderSection();

    const frame = space(caption);
    expect(frame.dataset['space']).toBe(width);
    expect(frame.children).toHaveLength(1);
    expect(group(caption)).toHaveAttribute('data-block', '');
  });

  it.each([
    ['a block button in a row in 17rem', buttonRowClass],
    ['a block button in a row in 50rem', buttonRowClass],
    ['a block button in a stack in 50rem', buttonStackClass],
  ])('draws %s', (caption, className) => {
    renderSection();

    expect(group(caption).className).toBe(className);
    expect(group(caption).querySelector('[data-block]')).not.toBeNull();
  });
});
