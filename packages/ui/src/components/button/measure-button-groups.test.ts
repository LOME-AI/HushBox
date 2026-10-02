import { describe, it, expect, afterEach, vi } from 'vitest';
import { buttonRowClass, buttonStackClass } from './button-group-classes';
import { observeTextMetrics } from '../../lib/observe-text-metrics';
import { measureButtonGroups } from './measure-button-groups';

vi.mock('../../lib/observe-text-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/observe-text-metrics')>();
  return { observeTextMetrics: vi.fn(actual.observeTextMetrics) };
});

/**
 * A button whose width reads `labelWidth` only while it is laid out at its label's own
 * width, as a browser reads it; happy-dom lays nothing out, so every other reading is 0.
 */
function button(label: string, labelWidth: number): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  Object.defineProperty(element, 'offsetWidth', {
    configurable: true,
    get: () => (element.style.width === 'max-content' ? labelWidth : 0),
  });
  return element;
}

/** Records each resize observer the code under test creates. */
class RecordingResizeObserver implements ResizeObserver {
  static readonly instances: RecordingResizeObserver[] = [];
  constructor() {
    RecordingResizeObserver.instances.push(this);
  }
  observe(): void {
    /* records creation only */
  }
  unobserve(): void {
    /* records creation only */
  }
  disconnect(): void {
    /* records creation only */
  }
}

/** A stylesheet standing in for a stack's direction. */
function groupStyles(): void {
  const style = document.createElement('style');
  style.textContent = '.flex-col { flex-direction: column; }';
  document.head.append(style);
}

function iconButton(width: number): HTMLButtonElement {
  const element = button('', width);
  element.dataset['slot'] = 'icon-button';
  return element;
}

function group(className: string, ...children: HTMLElement[]): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  element.append(...children);
  document.body.append(element);
  return element;
}

function equalWidth(element: HTMLElement): string {
  return element.style.getPropertyValue('--btn-eq');
}

function count(element: HTMLElement): string {
  return element.style.getPropertyValue('--btn-count');
}

/** Lets queued observer callbacks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const disposers: (() => void)[] = [];

function measure(root: ParentNode): void {
  disposers.push(measureButtonGroups(root));
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  document.head.replaceChildren();
  document.documentElement.className = '';
  Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
  RecordingResizeObserver.instances.length = 0;
  vi.mocked(observeTextMetrics).mockClear();
});

describe('measureButtonGroups', () => {
  it('gives a row its widest label plus 1px', () => {
    const row = group(buttonRowClass, button('Cancel', 64), button('Change password', 151));

    measure(document);

    expect(equalWidth(row)).toBe('152px');
  });

  it('gives a stack its widest label plus 1px', () => {
    const stack = group(
      buttonStackClass,
      button('Copy', 58),
      button('Download .txt', 120),
      button("I've written it down", 170)
    );

    measure(document);

    expect(equalWidth(stack)).toBe('171px');
  });

  it('counts the buttons it measured', () => {
    const row = group(buttonRowClass, button('Cancel', 64), button('Save', 50));

    measure(document);

    expect(count(row)).toBe('2');
  });

  it('leaves icon buttons out of the widest label', () => {
    const row = group(buttonRowClass, button('Save', 50), iconButton(400));

    measure(document);

    expect(equalWidth(row)).toBe('51px');
  });

  it('leaves icon buttons out of the count', () => {
    const row = group(buttonRowClass, button('Save', 50), iconButton(36));

    measure(document);

    expect(count(row)).toBe('1');
  });

  it('measures each group on its own', () => {
    const narrow = group(buttonRowClass, button('Save', 50));
    const wide = group(buttonRowClass, button('Continue with a passkey', 200));

    measure(document);

    expect([equalWidth(narrow), equalWidth(wide)]).toEqual(['51px', '201px']);
  });

  it('measures the root itself when the root is a group', () => {
    const row = group(buttonRowClass, button('Save', 50));

    measure(row);

    expect(equalWidth(row)).toBe('51px');
  });

  it('ignores an element that is not a button group', () => {
    const plain = group('flex gap-2', button('Save', 50));

    measure(document);

    expect(equalWidth(plain)).toBe('');
  });

  it('writes nothing for a group with no labelled button', () => {
    const row = group(buttonRowClass, iconButton(36));

    measure(document);

    expect(equalWidth(row)).toBe('');
  });

  it('restores the inline style a button carried before measuring', () => {
    const styled = button('Save', 50);
    styled.setAttribute('style', 'order: 2');
    group(buttonRowClass, styled);

    measure(document);

    expect(styled.getAttribute('style')).toBe('order: 2');
  });

  it('leaves no inline style on a button that carried none', () => {
    const plain = button('Save', 50);
    group(buttonRowClass, plain);

    measure(document);

    expect(plain.hasAttribute('style')).toBe(false);
  });

  it('measures again when a label changes', async () => {
    const save = button('Save', 50);
    const row = group(buttonRowClass, save);
    measure(document);

    Object.defineProperty(save, 'offsetWidth', {
      configurable: true,
      get: () => (save.style.width === 'max-content' ? 90 : 0),
    });
    save.textContent = 'Save changes';
    await settle();

    expect(equalWidth(row)).toBe('91px');
  });

  it('measures again when a button joins the group', async () => {
    const row = group(buttonRowClass, button('Save', 50));
    measure(document);

    row.append(button('Discard changes', 130));
    await settle();

    expect(equalWidth(row)).toBe('131px');
  });

  it('measures again when the window resizes', () => {
    const save = button('Save', 50);
    const row = group(buttonRowClass, save);
    measure(document);

    Object.defineProperty(save, 'offsetWidth', {
      configurable: true,
      get: () => (save.style.width === 'max-content' ? 54 : 0),
    });
    globalThis.dispatchEvent(new Event('resize'));

    expect(equalWidth(row)).toBe('55px');
  });

  it('measures again when the root element changes its text size class', async () => {
    const save = button('Save', 50);
    const row = group(buttonRowClass, save);
    measure(document);

    Object.defineProperty(save, 'offsetWidth', {
      configurable: true,
      get: () => (save.style.width === 'max-content' ? 70 : 0),
    });
    document.documentElement.classList.add('a11y-font-scale-141');
    await settle();

    expect(equalWidth(row)).toBe('71px');
  });

  it('measures again when fonts finish loading', () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    const save = button('Save', 50);
    const row = group(buttonRowClass, save);
    measure(document);

    Object.defineProperty(save, 'offsetWidth', {
      configurable: true,
      get: () => (save.style.width === 'max-content' ? 58 : 0),
    });
    fonts.dispatchEvent(new Event('loadingdone'));

    expect(equalWidth(row)).toBe('59px');
  });

  it('stops measuring once disposed', async () => {
    const save = button('Save', 50);
    const row = group(buttonRowClass, save);
    const dispose = measureButtonGroups(document);

    dispose();
    Object.defineProperty(save, 'offsetWidth', {
      configurable: true,
      get: () => (save.style.width === 'max-content' ? 90 : 0),
    });
    save.textContent = 'Save changes';
    globalThis.dispatchEvent(new Event('resize'));
    document.documentElement.classList.add('a11y-font-scale-141');
    await settle();

    expect(equalWidth(row)).toBe('51px');
  });

  it('measures again on each change the shared text-metric observer reports', () => {
    const save = button('Save', 50);
    const row = group(buttonRowClass, save);
    measure(document);
    const onChange = vi.mocked(observeTextMetrics).mock.lastCall?.[0];

    Object.defineProperty(save, 'offsetWidth', {
      configurable: true,
      get: () => (save.style.width === 'max-content' ? 62 : 0),
    });
    onChange?.();

    expect(equalWidth(row)).toBe('63px');
  });

  it('releases the shared text-metric observer once disposed', () => {
    const release = vi.fn();
    vi.mocked(observeTextMetrics).mockReturnValueOnce(release);
    group(buttonRowClass, button('Save', 50));

    measureButtonGroups(document)();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('marks a row to wrap its labels', () => {
    const row = group(buttonRowClass, button('Cancel', 64), button('Change password', 151));

    measure(document);

    expect(row).toHaveAttribute('data-wrap-labels');
  });

  it('lets two labelled buttons in a row share its line', () => {
    groupStyles();
    const row = group(buttonRowClass, button('Cancel', 64), button('Change password', 151));

    measure(document);

    expect(row.dataset['wrapLabels']).toBe('shared');
  });

  it('marks a row with one labelled button beside an icon button without sharing', () => {
    groupStyles();
    const row = group(buttonRowClass, button('Regenerate', 90), iconButton(36));

    measure(document);

    expect(row.dataset['wrapLabels']).toBe('');
  });

  it('marks a stack without sharing', () => {
    groupStyles();
    const stack = group(buttonStackClass, button('Copy', 58), button("I've written it down", 170));

    measure(document);

    expect(stack.dataset['wrapLabels']).toBe('');
  });

  it('marks a group with no labelled button without sharing', () => {
    const row = group(buttonRowClass, iconButton(36));

    measure(document);

    expect(row.dataset['wrapLabels']).toBe('');
  });

  it('lets a row share its line again once a second labelled button joins it', async () => {
    groupStyles();
    const row = group(buttonRowClass, button('Save', 50));
    measure(document);

    row.append(button('Discard changes', 130));
    await settle();

    expect(row.dataset['wrapLabels']).toBe('shared');
  });

  it('never changes a group inside a resize observer', () => {
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
    group(buttonRowClass, button('Save', 50));

    measure(document);

    expect(RecordingResizeObserver.instances).toEqual([]);
  });
});
