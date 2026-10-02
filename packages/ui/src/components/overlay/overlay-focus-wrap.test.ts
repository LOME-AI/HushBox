import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapShiftTabFromContainer } from './overlay-focus-wrap';

/** Renders a container that runs the handler, holding `children`, and focuses the container. */
function renderFocusedContainer(...children: React.ReactNode[]): HTMLElement {
  render(
    React.createElement(
      'div',
      {
        role: 'group',
        'aria-label': 'Container',
        tabIndex: -1,
        onKeyDown: wrapShiftTabFromContainer,
      },
      ...children
    )
  );
  const container = screen.getByRole('group', { name: 'Container' });
  container.focus();
  return container;
}

function button(label: string, disabled = false): React.ReactElement {
  return React.createElement('button', { type: 'button', disabled }, label);
}

describe('wrapShiftTabFromContainer', () => {
  it('moves Shift+Tab from the container to its last control', () => {
    const container = renderFocusedContainer(button('First'), button('Second'));

    fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });

    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
  });

  it("prevents the browser's own Shift+Tab once it has moved focus", () => {
    const container = renderFocusedContainer(button('First'), button('Second'));

    const notPrevented = fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });

    expect(notPrevented).toBe(false);
  });

  it('skips a last control that cannot take focus', () => {
    const container = renderFocusedContainer(button('First'), button('Second', true));

    fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('leaves focus on a container that holds no control', () => {
    const container = renderFocusedContainer(React.createElement('p', null, 'Nothing to focus'));

    fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });

    expect(container).toHaveFocus();
  });

  it('reports no error for a container that holds no control', () => {
    const errors: unknown[] = [];
    const record = (event: ErrorEvent): void => {
      errors.push(event.error);
    };
    globalThis.addEventListener('error', record);
    try {
      const container = renderFocusedContainer(React.createElement('p', null, 'Nothing to focus'));

      fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });

      expect(errors).toEqual([]);
    } finally {
      globalThis.removeEventListener('error', record);
    }
  });

  it('leaves a plain Tab from the container to the browser', () => {
    const container = renderFocusedContainer(button('First'), button('Second'));

    const notPrevented = fireEvent.keyDown(container, { key: 'Tab' });

    expect({ notPrevented, focused: document.activeElement }).toEqual({
      notPrevented: true,
      focused: container,
    });
  });

  it('leaves Shift+Tab from a control inside the container to the browser', () => {
    renderFocusedContainer(button('First'), button('Second'));
    const first = screen.getByRole('button', { name: 'First' });
    first.focus();

    const notPrevented = fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });

    expect({ notPrevented, focused: document.activeElement }).toEqual({
      notPrevented: true,
      focused: first,
    });
  });

  it('leaves Shift pressed alone to the browser', () => {
    const container = renderFocusedContainer(button('First'), button('Second'));

    const notPrevented = fireEvent.keyDown(container, { key: 'Shift', shiftKey: true });

    expect({ notPrevented, focused: document.activeElement }).toEqual({
      notPrevented: true,
      focused: container,
    });
  });
});
