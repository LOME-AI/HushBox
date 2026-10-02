import { afterEach, describe, it, expect } from 'vitest';
import { focusHeading } from './focus-heading';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('focusHeading', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('focuses the first level-one heading inside the root', () => {
    const root = mount('<h1>First</h1><h1>Second</h1>');

    focusHeading(root);

    expect(document.activeElement).toBe(root.querySelector('h1'));
  });

  it('makes the heading focusable by script only', () => {
    const root = mount('<h1>Title</h1>');

    focusHeading(root);

    expect(root.querySelector('h1')).toHaveAttribute('tabindex', '-1');
  });

  it('keeps a tabindex the heading already carries', () => {
    const root = mount('<h1 tabindex="0">Title</h1>');

    focusHeading(root);

    expect(root.querySelector('h1')).toHaveAttribute('tabindex', '0');
  });

  it('does nothing when the root holds no heading', () => {
    const root = mount('<p>No heading</p>');

    focusHeading(root);

    expect(document.activeElement).toBe(document.body);
  });

  it('does nothing without a root', () => {
    focusHeading(null);

    expect(document.activeElement).toBe(document.body);
  });
});
