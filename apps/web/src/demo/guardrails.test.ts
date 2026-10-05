import { describe, it, expect, afterEach, vi } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import {
  webPaletteSections,
  type WebPaletteItem,
} from '@/components/command-palette/palette-items';
import { modeChipLabel } from '@/components/chat/input/mode-menu';
import {
  PALETTE_NUDGES,
  findBlockedAction,
  resolveClickNudge,
  resolveKeyNudge,
  installGuardrails,
} from './guardrails';
import { DEMO_CONVERSATIONS } from './mock-backend/fixtures';
import type { ChatModality } from '@hushbox/shared';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Marks a dispatched event as a person's, which the test environment cannot mint. */
function trusted<E extends Event>(event: E): E {
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

function buttonWithTestId(testId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.dataset['testid'] = testId;
  document.body.append(button);
  return button;
}

/**
 * A menu item named by its title element, as the shared menu renders one, carrying `testId`
 * when the app gives it one.
 */
function menuItem(role: 'menuitem' | 'menuitemradio', title: string, testId?: string): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', role);
  if (testId !== undefined) item.dataset['testid'] = testId;
  const label = document.createElement('span');
  label.id = `item-${role}-${title.replaceAll(' ', '-')}`;
  label.textContent = title;
  item.setAttribute('aria-labelledby', label.id);
  item.append(label);
  document.body.append(item);
  return item;
}

function modeItem(modality: ChatModality): HTMLElement {
  return menuItem('menuitemradio', modality, TEST_ID_BUILDERS.modeMenuItem(modality));
}

function accessibilityItem(): HTMLElement {
  return menuItem('menuitem', 'Accessibility', TEST_IDS.moreOptionsAccessibility);
}

/** A menu's trigger, open or closed. */
function trigger(attributes: Readonly<Record<string, string>>, expanded: boolean): void {
  const button = document.createElement('button');
  for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
  button.setAttribute('aria-expanded', String(expanded));
  document.body.append(button);
}

let paletteOptionCount = 0;

/** A command palette row under its section heading, drawn as the palette draws it. */
function paletteOption(heading: string, label: string, meta = ''): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('aria-label', heading);
  const option = document.createElement('div');
  option.setAttribute('role', 'option');
  // Ids as React mints them: no spaces, so a selector reaches them unescaped.
  paletteOptionCount += 1;
  option.id = `palette-option-${String(paletteOptionCount)}`;
  option.dataset['testid'] = TEST_IDS.commandPaletteOption;
  const iconTile = document.createElement('span');
  iconTile.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  const metaSpan = document.createElement('span');
  metaSpan.textContent = meta;
  option.append(iconTile, labelSpan, metaSpan);
  section.append(option);
  document.body.append(section);
  return option;
}

type PaletteAction = Extract<WebPaletteItem, { kind: 'action' }>['action'];

interface ActionRow {
  heading: string;
  label: string;
  action: PaletteAction;
}

/** The palette's rows a visitor is offered only with an account, by section heading. */
function accountOnlyPaletteRows(): ActionRow[] {
  const rows = (signedIn: boolean): ActionRow[] =>
    webPaletteSections({ query: '', conversations: [], signedIn, now: new Date() }).flatMap(
      (section) =>
        section.items.flatMap((item) =>
          item.kind === 'action'
            ? [{ heading: section.heading, label: item.label, action: item.action }]
            : []
        )
    );
  const signedOut = new Set(rows(false).map((row) => row.action));
  return rows(true).filter((row) => !signedOut.has(row.action));
}

/** The palette's rows the demo nudges: those needing an account, and the Accessibility page. */
function nudgedPaletteRows(): ActionRow[] {
  const accessibility = webPaletteSections({
    query: '',
    conversations: [],
    signedIn: false,
    now: new Date(),
  }).flatMap((section) =>
    section.items.flatMap((item) =>
      item.kind === 'action' && item.action === 'accessibilityPage'
        ? [{ heading: section.heading, label: item.label, action: item.action }]
        : []
    )
  );
  return [...accountOnlyPaletteRows(), ...accessibility];
}

/** The section and label a palette row takes once its own label is typed as the query. */
function searchedRow(label: string): { heading: string; label: string } {
  const [top] = webPaletteSections({
    query: label,
    conversations: [],
    signedIn: true,
    now: new Date(),
  });
  const item = top?.items[0];
  if (top === undefined || item === undefined) throw new Error(`nothing matches ${label}`);
  return { heading: top.heading, label: item.label };
}

describe('findBlockedAction', () => {
  it('blocks denylisted test-ids (including icon children) and dynamic prefixes', () => {
    const button = buttonWithTestId('menu-logout');
    const icon = document.createElement('img');
    button.append(icon);
    expect(findBlockedAction(icon)).toBe('log out');

    expect(findBlockedAction(buttonWithTestId('member-remove-action-abc'))).toBe('manage members');
  });

  it('blocks message-write actions by aria-label', () => {
    const share = document.createElement('button');
    share.setAttribute('aria-label', 'Share');
    expect(findBlockedAction(share)).toBe('share messages');
  });

  it('blocks the destructive member and link paths, leave conversation included', () => {
    expect(findBlockedAction(buttonWithTestId('member-leave-action'))).toBe('leave conversations');
    expect(findBlockedAction(buttonWithTestId('member-actions-abc'))).toBe('manage members');
    expect(findBlockedAction(buttonWithTestId('link-actions-xyz'))).toBe('manage links');
  });

  it('keys on no retired app-menu accessibility item', () => {
    expect(findBlockedAction(buttonWithTestId(TEST_IDS.menuAccessibility))).toBeNull();
  });

  it('blocks renaming a branch', () => {
    expect(findBlockedAction(buttonWithTestId(TEST_ID_BUILDERS.branchRename('fork-1')))).toBe(
      'rename branches'
    );
  });

  it('blocks deleting a branch', () => {
    expect(findBlockedAction(buttonWithTestId(TEST_ID_BUILDERS.branchDelete('fork-1')))).toBe(
      'delete branches'
    );
  });

  it('blocks continuing a comparison with one model', () => {
    expect(findBlockedAction(buttonWithTestId(TEST_IDS.continueWithModel))).toBe(
      'continue with one model'
    );
  });

  it('blocks the More options Accessibility item by its test id', () => {
    expect(findBlockedAction(accessibilityItem())).toBe('open accessibility settings');
  });

  it('leaves an item only named Accessibility alone', () => {
    trigger({ 'aria-label': 'More options', 'data-testid': TEST_IDS.moreOptionsButton }, true);
    expect(findBlockedAction(menuItem('menuitem', 'Accessibility'))).toBeNull();
  });

  it('blocks every palette action that needs an account, each with its own nudge', () => {
    const rows = accountOnlyPaletteRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const option = paletteOption(row.heading, row.label, 'Ctrl ,');
      expect(findBlockedAction(option.firstElementChild)).toBe(PALETTE_NUDGES[row.action]);
    }
  });

  it("blocks the palette's Accessibility page row as More options' Accessibility is blocked", () => {
    const row = nudgedPaletteRows().find((candidate) => candidate.action === 'accessibilityPage');
    if (row === undefined) throw new Error('no Accessibility palette row');
    expect(findBlockedAction(paletteOption(row.heading, row.label))).toBe(
      findBlockedAction(accessibilityItem())
    );
  });

  it.each(nudgedPaletteRows().map((row) => [row.label, row] as const))(
    'blocks the %s row when a search lifts it to the top result',
    (_label, row) => {
      const searched = searchedRow(row.label);
      expect(searched.heading).not.toBe(row.heading);

      const option = paletteOption(searched.heading, searched.label);

      expect(findBlockedAction(option)).toBe(PALETTE_NUDGES[row.action]);
    }
  );

  it('names a nudge for exactly the account-only palette actions and the Accessibility page', () => {
    expect(new Set(Object.keys(PALETTE_NUDGES))).toEqual(
      new Set(nudgedPaletteRows().map((row) => row.action))
    );
  });

  it('lets the palette rows it does not nudge through', () => {
    const nudged = new Set(nudgedPaletteRows().map((row) => row.label));
    const offered = webPaletteSections({
      query: '',
      conversations: [],
      signedIn: false,
      now: new Date(),
    }).flatMap((section) => section.items.map((item) => ({ heading: section.heading, item })));
    const passed = offered.filter(({ item }) => !nudged.has(item.label));
    expect(passed.length).toBeGreaterThan(0);
    for (const { heading, item } of passed) {
      expect(findBlockedAction(paletteOption(heading, item.label))).toBeNull();
    }
  });

  it('titles no demo conversation like a nudged palette row, so a row is told apart by its label', () => {
    const nudged = new Set(nudgedPaletteRows().map((row) => row.label));
    expect(DEMO_CONVERSATIONS.filter((conversation) => nudged.has(conversation.title))).toEqual([]);
  });

  it('lets a conversation row named like an account action through', () => {
    const [row] = accountOnlyPaletteRows();
    if (row === undefined) throw new Error('no account-only palette row');
    expect(findBlockedAction(paletteOption('Recent', `${row.label} notes`))).toBeNull();
  });

  it('allows supported controls (copy, regenerate, retry, conversation links, null)', () => {
    for (const label of ['Copy', 'Regenerate', 'Retry']) {
      const button = document.createElement('button');
      button.setAttribute('aria-label', label);
      expect(findBlockedAction(button)).toBeNull();
    }
    expect(findBlockedAction(buttonWithTestId('chat-link'))).toBeNull();
    expect(findBlockedAction(null)).toBeNull();
  });
});

describe('resolveClickNudge', () => {
  it('nudges blocked controls regardless of trust', () => {
    const logout = buttonWithTestId('menu-logout');
    expect(resolveClickNudge(logout, false)).toBe('log out');
    expect(resolveClickNudge(logout, true)).toBe('log out');
  });

  it("nudges a person's choice of a mode in the open mode menu", () => {
    expect(resolveClickNudge(modeItem('video'), true)).toBe('switch modes');
  });

  it("lets the director's choice of a mode through", () => {
    expect(resolveClickNudge(modeItem('video'), false)).toBeNull();
  });

  it("nudges a person's press of the mode chip", () => {
    const chip = document.createElement('button');
    chip.setAttribute('aria-label', modeChipLabel('image'));
    document.body.append(chip);
    expect(resolveClickNudge(chip, true)).toBe('switch modes');
  });

  it('lets a radio item with no mode test id through while the mode menu is open', () => {
    trigger({ 'data-testid': TEST_IDS.modeMenuButton }, true);
    expect(resolveClickNudge(menuItem('menuitemradio', 'High'), true)).toBeNull();
  });

  it('lets a person open the mode menu', () => {
    const plus = buttonWithTestId(TEST_IDS.modeMenuButton);
    expect(resolveClickNudge(plus, true)).toBeNull();
  });

  it('allows supported controls', () => {
    const copy = document.createElement('button');
    copy.setAttribute('aria-label', 'Copy');
    expect(resolveClickNudge(copy, true)).toBeNull();
  });
});

describe('resolveKeyNudge', () => {
  it("nudges a person's Enter on a mode in the open mode menu", () => {
    expect(resolveKeyNudge('Enter', modeItem('image'), true)).toBe('switch modes');
  });

  it("nudges a person's Space on a blocked menu item", () => {
    expect(resolveKeyNudge(' ', accessibilityItem(), true)).toBe('open accessibility settings');
  });

  it('nudges Enter in the palette field while an account-only row is selected', () => {
    const [row] = accountOnlyPaletteRows();
    if (row === undefined) throw new Error('no account-only palette row');
    const option = paletteOption(row.heading, row.label);
    const field = document.createElement('input');
    field.setAttribute('aria-activedescendant', option.id);
    document.body.append(field);

    expect(resolveKeyNudge('Enter', field, true)).toBe(PALETTE_NUDGES[row.action]);
  });

  it.each(nudgedPaletteRows().map((row) => [row.label, row] as const))(
    'nudges Enter in the palette field while the searched %s row is selected',
    (_label, row) => {
      const searched = searchedRow(row.label);
      const option = paletteOption(searched.heading, searched.label);
      const field = document.createElement('input');
      field.setAttribute('aria-activedescendant', option.id);
      document.body.append(field);

      expect(resolveKeyNudge('Enter', field, true)).toBe(PALETTE_NUDGES[row.action]);
    }
  );

  it('lets a space typed in the palette field through', () => {
    const [row] = accountOnlyPaletteRows();
    if (row === undefined) throw new Error('no account-only palette row');
    const option = paletteOption(row.heading, row.label);
    const field = document.createElement('input');
    field.setAttribute('aria-activedescendant', option.id);
    document.body.append(field);

    expect(resolveKeyNudge(' ', field, true)).toBeNull();
  });

  it('lets other keys through', () => {
    expect(resolveKeyNudge('ArrowDown', modeItem('image'), true)).toBeNull();
  });

  it('lets untrusted keys through', () => {
    expect(resolveKeyNudge('Enter', buttonWithTestId('menu-logout'), false)).toBeNull();
  });
});

describe('installGuardrails', () => {
  function nudgeElement(): Element {
    const nudge = document.querySelector(`[data-testid="${TEST_IDS.demoSignupNudge}"]`);
    if (nudge === null) throw new Error('no nudge');
    return nudge;
  }

  it('prevents the click and shows a nudge for a blocked control', () => {
    const uninstall = installGuardrails();
    const button = buttonWithTestId('menu-settings');
    let reachedTarget = false;
    button.addEventListener('click', () => {
      reachedTarget = true;
    });

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(reachedTarget).toBe(false);
    expect(nudgeElement().textContent).toContain('open settings');
    uninstall();
  });

  it('lets supported controls through', () => {
    const uninstall = installGuardrails();
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Copy');
    document.body.append(button);
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(clicked).toBe(true);
    uninstall();
  });

  it("stops a person's key on a mode before the menu chooses it", () => {
    const uninstall = installGuardrails();
    const item = modeItem('video');
    let chosen = false;
    item.addEventListener('keydown', () => {
      chosen = true;
    });

    const key = trusted(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    item.dispatchEvent(key);

    expect(chosen).toBe(false);
    expect(key.defaultPrevented).toBe(true);
    expect(nudgeElement().textContent).toBe('Create a free account to switch modes.');
    uninstall();
  });

  it('lets a key the guardrails do not nudge through', () => {
    const uninstall = installGuardrails();
    const field = document.createElement('textarea');
    document.body.append(field);
    let heard = false;
    field.addEventListener('keydown', () => {
      heard = true;
    });

    field.dispatchEvent(
      trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    );

    expect(heard).toBe(true);
    uninstall();
  });

  it('stops listening for keys once disposed', () => {
    const uninstall = installGuardrails();
    uninstall();
    const item = modeItem('video');
    let chosen = false;
    item.addEventListener('keydown', () => {
      chosen = true;
    });

    item.dispatchEvent(
      trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    );

    expect(chosen).toBe(true);
  });

  it('shows the nudge above an overlay that opened after the guardrails', () => {
    const uninstall = installGuardrails();
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const button = buttonWithTestId('menu-settings');

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(document.body.lastElementChild).toBe(nudgeElement());
    uninstall();
  });

  it('auto-hides the nudge after a delay and restarts the timer on a repeat nudge', () => {
    vi.useFakeTimers();
    try {
      const uninstall = installGuardrails();
      const button = buttonWithTestId('menu-settings');
      const nudge = nudgeElement();

      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(nudge.classList.contains('opacity-0')).toBe(false);

      // A second nudge before the first hide clears and restarts the timer.
      vi.advanceTimersByTime(1000);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(nudge.classList.contains('opacity-0')).toBe(false);
      // 1000ms after the second nudge — the first timer would have fired here had
      // it not been cleared; the nudge must still be visible.
      vi.advanceTimersByTime(1700);
      expect(nudge.classList.contains('opacity-0')).toBe(false);

      // Past the restarted 2600ms window, the hide callback runs.
      vi.advanceTimersByTime(1000);
      expect(nudge.classList.contains('opacity-0')).toBe(true);

      uninstall();
    } finally {
      vi.useRealTimers();
    }
  });
});
