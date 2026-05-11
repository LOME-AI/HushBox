import { render, fireEvent, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageStructure } from './page-structure';

interface CapturedObserver {
  callback: MutationCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

let observers: CapturedObserver[];

class MockMutationObserver {
  callback: MutationCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;

  constructor(callback: MutationCallback) {
    this.callback = callback;
    this.observe = vi.fn();
    this.disconnect = vi.fn();
    observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
  }

  takeRecords(): MutationRecord[] {
    return [];
  }
}

function makeOnScreen(element: HTMLElement): void {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
}

function makeOffScreen(element: HTMLElement): void {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => null,
  });
}

/**
 * jsdom reports `offsetParent === null` for every element because it does no
 * layout. Tests use the production `offsetParent === null` signal to skip
 * off-screen items, so we need a way to mark "visible by default" elements
 * as on-screen. This wraps `Element.prototype.offsetParent` so the default
 * is `document.body` unless a per-element override has been installed.
 */
function patchOffsetParentDefault(): () => void {
  const proto = HTMLElement.prototype;
  const originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'offsetParent');
  Object.defineProperty(proto, 'offsetParent', {
    configurable: true,
    get(): Element | null {
      return this.parentElement === null ? null : document.body;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(proto, 'offsetParent', originalDescriptor);
    } else {
      delete (proto as unknown as Record<string, unknown>)['offsetParent'];
    }
  };
}

describe('PageStructure', () => {
  let restoreOffsetParent: () => void;

  beforeEach(() => {
    observers = [];
    vi.stubGlobal('MutationObserver', MockMutationObserver);
    vi.useFakeTimers();
    restoreOffsetParent = patchOffsetParentDefault();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreOffsetParent();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders nothing when disabled', () => {
    document.body.innerHTML = '<h1>Hello</h1>';
    const { container } = render(<PageStructure enabled={false} />);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('renders a navigation landmark with the expected aria-label when enabled', () => {
    document.body.innerHTML = '<h1>Hello</h1>';
    render(<PageStructure enabled />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    expect(nav.tagName).toBe('NAV');
  });

  it('uses a short friendly label for landmarks instead of the full textContent', () => {
    document.body.innerHTML = `
      <main>
        <p>A really long paragraph that should never become the label for the main landmark because that would render an entire page of raw text inside the outline.</p>
      </main>
    `;
    render(<PageStructure enabled />);
    const button = screen.getByRole('button', { name: 'Main content' });
    expect(button).toBeInTheDocument();
    expect(button.textContent).toBe('Main content');
  });

  it('truncates long heading labels to keep the outline readable', () => {
    const longText = 'A'.repeat(200);
    document.body.innerHTML = `<h1>${longText}</h1>`;
    render(<PageStructure enabled />);
    const button = screen.getByRole('button');
    expect(button.textContent.length).toBeLessThanOrEqual(70);
    expect(button.textContent.endsWith('…')).toBe(true);
  });

  it('lists every heading found in the document', () => {
    document.body.innerHTML = `
      <h1>Title</h1>
      <h2>Section</h2>
      <h3>Subsection</h3>
    `;
    render(<PageStructure enabled />);
    const buttons = screen.getAllByRole('button');
    const labels = buttons.map((button) => button.textContent);
    expect(labels).toContain('Title');
    expect(labels).toContain('Section');
    expect(labels).toContain('Subsection');
  });

  it('lists landmark elements (main, nav, aside) and ARIA-labelled regions', () => {
    document.body.innerHTML = `
      <main aria-label="Main content"></main>
      <nav aria-label="Primary"></nav>
      <aside aria-label="Sidebar"></aside>
      <div role="region" aria-label="Status"></div>
    `;
    render(<PageStructure enabled />);
    const buttons = screen.getAllByRole('button');
    const labels = buttons.map((button) => button.textContent);
    expect(labels).toContain('Main content');
    expect(labels).toContain('Primary');
    expect(labels).toContain('Sidebar');
    expect(labels).toContain('Status');
  });

  it('exposes both the tag name and heading level for each item', () => {
    document.body.innerHTML = `
      <h2>Two</h2>
      <main aria-label="Main content"></main>
    `;
    render(<PageStructure enabled />);
    const headingButton = screen.getByRole('button', { name: /Two/ });
    const mainButton = screen.getByRole('button', { name: /Main content/ });
    expect(headingButton.dataset['level']).toBe('2');
    expect(headingButton.dataset['tag']).toBe('H2');
    expect(mainButton.dataset['level']).toBe('0');
    expect(mainButton.dataset['tag']).toBe('MAIN');
  });

  it('skips elements inside an aria-hidden subtree', () => {
    document.body.innerHTML = `
      <h1>Visible</h1>
      <div aria-hidden="true"><h2>Hidden</h2></div>
    `;
    render(<PageStructure enabled />);
    expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Visible' })).toBeInTheDocument();
  });

  it('skips elements whose offsetParent is null (off-screen virtualized)', () => {
    document.body.innerHTML = `
      <h1 id="visible-h">On Screen</h1>
      <h2 id="hidden-h">Off Screen</h2>
    `;
    const visible = document.querySelector<HTMLElement>('#visible-h');
    const hidden = document.querySelector<HTMLElement>('#hidden-h');
    expect(visible).not.toBeNull();
    expect(hidden).not.toBeNull();
    makeOnScreen(visible!);
    makeOffScreen(hidden!);

    render(<PageStructure enabled />);
    expect(screen.getByRole('button', { name: 'On Screen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Off Screen' })).toBeNull();
  });

  it('only walks within containerSelector when provided', () => {
    document.body.innerHTML = `
      <h1>Outside</h1>
      <div id="scope">
        <h1>Inside A</h1>
        <h2>Inside B</h2>
      </div>
    `;
    render(<PageStructure enabled containerSelector="#scope" />);
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Inside A', 'Inside B']));
    expect(labels).not.toContain('Outside');
  });

  it('clicking an item scrolls to the target and focuses it', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    const heading = document.querySelector<HTMLElement>('h1');
    expect(heading).not.toBeNull();
    const scrollSpy = vi.fn();
    const focusSpy = vi.spyOn(heading!, 'focus');
    heading!.scrollIntoView = scrollSpy;

    render(<PageStructure enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Heading' }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('assigns a tabindex of -1 before focusing a non-focusable target', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    const heading = document.querySelector<HTMLElement>('h1');
    expect(heading).not.toBeNull();
    heading!.scrollIntoView = vi.fn();

    render(<PageStructure enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Heading' }));

    expect(heading!.getAttribute('tabindex')).toBe('-1');
  });

  it('does not overwrite tabindex on an already focusable target', () => {
    document.body.innerHTML = '<button id="bt">Existing</button>';
    const button = document.querySelector<HTMLElement>('#bt');
    expect(button).not.toBeNull();
    button!.setAttribute('aria-label', 'Existing button label');
    button!.setAttribute('role', 'region');
    button!.scrollIntoView = vi.fn();

    render(<PageStructure enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Existing button label' }));

    expect(button!.hasAttribute('tabindex')).toBe(false);
  });

  it('assigns an id to the target if one is missing on click', () => {
    document.body.innerHTML = '<h1>No Id Heading</h1>';
    const heading = document.querySelector<HTMLElement>('h1');
    expect(heading).not.toBeNull();
    heading!.scrollIntoView = vi.fn();

    render(<PageStructure enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'No Id Heading' }));

    expect(heading!.id.length).toBeGreaterThan(0);
  });

  it('preserves an existing id on the target', () => {
    document.body.innerHTML = '<h1 id="kept">With Id</h1>';
    const heading = document.querySelector<HTMLElement>('h1');
    expect(heading).not.toBeNull();
    heading!.scrollIntoView = vi.fn();

    render(<PageStructure enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'With Id' }));

    expect(heading!.id).toBe('kept');
  });

  it('observes the container with a MutationObserver when enabled', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    render(<PageStructure enabled />);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observe).toHaveBeenCalledWith(
      document.body,
      expect.objectContaining({ childList: true, subtree: true })
    );
  });

  it('refreshes the list after a debounced DOM mutation', () => {
    document.body.innerHTML = '<h1>Initial</h1>';
    render(<PageStructure enabled />);
    expect(screen.getByRole('button', { name: 'Initial' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Added' })).toBeNull();

    const newHeading = document.createElement('h2');
    newHeading.textContent = 'Added';
    document.body.append(newHeading);

    act(() => {
      observers[0]?.callback([], observers[0] as unknown as MutationObserver);
      vi.advanceTimersByTime(150);
    });

    expect(screen.getByRole('button', { name: 'Added' })).toBeInTheDocument();
  });

  it('debounces multiple mutations within the window into a single refresh', () => {
    document.body.innerHTML = '<h1>Initial</h1>';
    render(<PageStructure enabled />);

    const headingA = document.createElement('h2');
    headingA.textContent = 'Burst A';
    document.body.append(headingA);

    act(() => {
      observers[0]?.callback([], observers[0] as unknown as MutationObserver);
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole('button', { name: 'Burst A' })).toBeNull();

    const headingB = document.createElement('h2');
    headingB.textContent = 'Burst B';
    document.body.append(headingB);

    act(() => {
      observers[0]?.callback([], observers[0] as unknown as MutationObserver);
      vi.advanceTimersByTime(150);
    });

    expect(screen.getByRole('button', { name: 'Burst A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Burst B' })).toBeInTheDocument();
  });

  it('disconnects the observer on unmount', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    const { unmount } = render(<PageStructure enabled />);
    expect(observers[0]?.disconnect).not.toHaveBeenCalled();
    unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects the observer when toggled from enabled to disabled', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    const { rerender } = render(<PageStructure enabled />);
    rerender(<PageStructure enabled={false} />);
    expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('forwards className to the nav element', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    render(<PageStructure enabled className="custom-class" />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    expect(nav).toHaveClass('custom-class');
  });

  it('renders items inside an unordered list', () => {
    document.body.innerHTML = '<h1>Heading</h1>';
    render(<PageStructure enabled />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    const list = nav.querySelector('ul');
    expect(list).not.toBeNull();
    const items = list?.querySelectorAll('li');
    expect(items?.length).toBeGreaterThan(0);
  });

  it('falls back to the friendly landmark name when an unlabelled main lacks text content', () => {
    document.body.innerHTML = '<main></main>';
    render(<PageStructure enabled />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    const items = nav.querySelectorAll('button');
    expect(items.length).toBe(1);
    expect(items[0]?.textContent).toBe('Main content');
  });

  it('does not list a region without an aria-label', () => {
    document.body.innerHTML = `
      <h1>Heading</h1>
      <div role="region"></div>
    `;
    render(<PageStructure enabled />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    const items = nav.querySelectorAll('button');
    // Only the heading should be listed; the unlabelled region is excluded by the selector.
    expect(items.length).toBe(1);
    expect(items[0]?.textContent).toBe('Heading');
  });

  it('shows an empty-state message when no qualifying elements exist', () => {
    document.body.innerHTML = '<p>No structure here</p>';
    render(<PageStructure enabled />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    const items = nav.querySelectorAll('button');
    expect(items.length).toBe(0);
    expect(nav.textContent).toContain('No headings or landmarks found');
  });
});
