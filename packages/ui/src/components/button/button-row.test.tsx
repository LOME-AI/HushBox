import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Button } from './button';
import { buttonLabelsRowClass, buttonRowClass } from './button-group-classes';
import { ButtonRow } from './button-row';

/** A resize observer the test fires by hand, standing in for the browser's layout. */
class ManualResizeObserver implements ResizeObserver {
  static readonly instances: ManualResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe(): void {
    /* the test fires it */
  }
  unobserve(): void {
    /* the test fires it */
  }
  disconnect(): void {
    this.disconnected = true;
  }
  disconnected = false;
  fire(): void {
    this.callback([], this);
  }
}

/** Draws every button whose label is in `below` on a line under the others. */
function layOut(below: readonly string[]): void {
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return below.includes(this.textContent) ? 44 : 0;
  });
}

function rowOf(container: HTMLElement): HTMLElement {
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error('no row rendered');
  return row;
}

function labelsInOrder(container: HTMLElement): string[] {
  return [...rowOf(container).children].map((child) => child.textContent);
}

function CancelOrChange(): React.JSX.Element {
  return (
    <ButtonRow>
      <Button variant="outline">Cancel</Button>
      <Button>Change password</Button>
    </ButtonRow>
  );
}

function PortalPair(): React.JSX.Element {
  return (
    <ButtonRow stack="labels" stackedOrder="reverse">
      <Button variant="outline">Add Credits</Button>
      <Button>Return to the app</Button>
    </ButtonRow>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ManualResizeObserver.instances.length = 0;
});

describe('ButtonRow', () => {
  it('puts the space-driven row class on its root', () => {
    const { container } = render(
      <ButtonRow>
        <Button>Save</Button>
      </ButtonRow>
    );

    expect(rowOf(container).className).toBe(buttonRowClass);
  });

  it('puts the label-driven row class on its root when it stacks by labels', () => {
    const { container } = render(
      <ButtonRow stack="labels">
        <Button>Save</Button>
      </ButtonRow>
    );

    expect(rowOf(container).className).toBe(buttonLabelsRowClass);
  });

  it('measures its widest label', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.style.width === 'max-content' ? 120 : 0;
    });
    const { container } = render(
      <ButtonRow>
        <Button>Save</Button>
      </ButtonRow>
    );

    expect(rowOf(container).style.getPropertyValue('--btn-eq')).toBe('121px');
  });

  it('renders its buttons in markup order while side by side', () => {
    layOut([]);
    const { container } = render(<PortalPair />);

    expect(labelsInOrder(container)).toEqual(['Add Credits', 'Return to the app']);
  });

  it('reverses its buttons in the document while stacked', () => {
    layOut(['Return to the app']);
    const { container } = render(<PortalPair />);

    expect(labelsInOrder(container)).toEqual(['Return to the app', 'Add Credits']);
  });

  it('puts the first drawn button first in focus order while stacked', async () => {
    layOut(['Return to the app']);
    render(<PortalPair />);

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.tab();

    expect(screen.getByRole('button', { name: 'Return to the app' })).toHaveFocus();
  });

  it('keeps markup order while stacked unless asked to reverse', () => {
    layOut(['Return to the app']);
    const { container } = render(
      <ButtonRow stack="labels">
        <Button variant="outline">Add Credits</Button>
        <Button>Return to the app</Button>
      </ButtonRow>
    );

    expect(labelsInOrder(container)).toEqual(['Add Credits', 'Return to the app']);
  });

  it('reverses once its row stacks after a resize', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    layOut([]);
    const { container } = render(<PortalPair />);

    layOut(['Add Credits']);
    act(() => {
      for (const observer of ManualResizeObserver.instances) observer.fire();
    });

    expect(labelsInOrder(container)).toEqual(['Return to the app', 'Add Credits']);
  });

  it('returns to markup order once its row stops stacking', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    layOut(['Return to the app']);
    const { container } = render(<PortalPair />);

    layOut([]);
    act(() => {
      for (const observer of ManualResizeObserver.instances) observer.fire();
    });

    expect(labelsInOrder(container)).toEqual(['Add Credits', 'Return to the app']);
  });

  it('stops watching its layout once unmounted', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { unmount } = render(<PortalPair />);

    unmount();

    expect(ManualResizeObserver.instances.map((observer) => observer.disconnected)).toEqual([true]);
  });

  it('decides its stacking from the same buttons its measure counts', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.style.width === 'max-content' ? 80 : 0;
    });
    layOut(['Close']);
    const { container } = render(
      <ButtonRow stackedOrder="reverse">
        <Button>Save</Button>
        <Button>Discard</Button>
        <button type="button" data-slot="icon-button">
          Close
        </button>
      </ButtonRow>
    );

    expect({
      counted: rowOf(container).style.getPropertyValue('--btn-count'),
      order: labelsInOrder(container),
    }).toEqual({ counted: '2', order: ['Save', 'Discard', 'Close'] });
  });

  it('marks its root to wrap its labels', () => {
    layOut([]);
    const { container } = render(<CancelOrChange />);

    expect(rowOf(container)).toHaveAttribute('data-wrap-labels');
  });

  it('leaves its buttons as given', () => {
    layOut(['Change password']);
    render(<CancelOrChange />);

    expect(
      screen.getAllByRole('button').map((button) => button.dataset['block'] !== undefined)
    ).toEqual([false, false]);
  });

  it('watches no layout when it keeps markup order', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    render(<CancelOrChange />);

    expect(ManualResizeObserver.instances).toEqual([]);
  });

  it('leaves an icon button out of the stacking test', () => {
    layOut(['Close']);
    const { container } = render(
      <ButtonRow stackedOrder="reverse">
        <Button>Save</Button>
        <button type="button" data-slot="icon-button">
          Close
        </button>
      </ButtonRow>
    );

    expect(labelsInOrder(container)).toEqual(['Save', 'Close']);
  });
});
