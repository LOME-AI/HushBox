import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { revealFocusAfterCancelledTab } from './reveal-focus-after-tab';

/**
 * Renders a container that runs the reveal, holding two buttons, inside a page that holds one
 * button outside it. The page's own keydown handler runs after the container's, as a focus
 * trap's handler runs after a consumer's: it cancels the keys `cancelledKey` names and moves
 * focus to whatever `focusTarget` returns.
 */
function renderContainer(options: {
  cancelledKey: string | null;
  focusTarget: () => HTMLElement | null;
}): void {
  const onPageKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== options.cancelledKey) return;
    event.preventDefault();
    options.focusTarget()?.focus();
  };
  render(
    React.createElement(
      'div',
      { onKeyDown: onPageKeyDown },
      React.createElement(
        'div',
        {
          role: 'group',
          'aria-label': 'Container',
          tabIndex: -1,
          onKeyDown: revealFocusAfterCancelledTab,
        },
        React.createElement('button', { type: 'button' }, 'First'),
        React.createElement('button', { type: 'button' }, 'Last')
      ),
      React.createElement('button', { type: 'button' }, 'Outside')
    )
  );
}

function control(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function container(): HTMLElement {
  return screen.getByRole('group', { name: 'Container' });
}

/** Resolves after every microtask the keydown's dispatch queued. */
async function afterDispatch(): Promise<void> {
  await Promise.resolve();
}

describe('revealFocusAfterCancelledTab', () => {
  it('reveals the control a later handler focused after cancelling Tab', async () => {
    renderContainer({ cancelledKey: 'Tab', focusTarget: () => control('First') });
    control('Last').focus();
    const scrollIntoView = vi.spyOn(control('First'), 'scrollIntoView');

    fireEvent.keyDown(control('Last'), { key: 'Tab' });
    await afterDispatch();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('reveals nothing after a Tab no handler cancelled', async () => {
    renderContainer({ cancelledKey: null, focusTarget: () => null });
    control('Last').focus();
    const scrollIntoView = vi.spyOn(control('Last'), 'scrollIntoView');

    fireEvent.keyDown(control('Last'), { key: 'Tab' });
    await afterDispatch();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('reveals nothing after another cancelled key', async () => {
    renderContainer({ cancelledKey: 'ArrowDown', focusTarget: () => control('First') });
    control('Last').focus();
    const scrollIntoView = vi.spyOn(control('First'), 'scrollIntoView');

    fireEvent.keyDown(control('Last'), { key: 'ArrowDown' });
    await afterDispatch();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('reveals nothing when focus rests on the container itself', async () => {
    renderContainer({ cancelledKey: 'Tab', focusTarget: () => container() });
    container().focus();
    const scrollIntoView = vi.spyOn(container(), 'scrollIntoView');

    fireEvent.keyDown(container(), { key: 'Tab' });
    await afterDispatch();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('reveals nothing when focus ends outside the container', async () => {
    renderContainer({ cancelledKey: 'Tab', focusTarget: () => control('Outside') });
    control('Last').focus();
    const scrollIntoView = vi.spyOn(control('Outside'), 'scrollIntoView');

    fireEvent.keyDown(control('Last'), { key: 'Tab' });
    await afterDispatch();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
