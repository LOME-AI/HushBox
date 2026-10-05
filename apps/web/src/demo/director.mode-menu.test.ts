import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS, TEST_SIGNALS, ROUTES } from '@hushbox/shared';
import { modeChipLabel } from '@/components/chat/input/mode-menu';
import type { DemoModality } from './mock-backend/fixtures';

let reduceMotion = true;
// @hushbox/ui is an external workspace package (not an internal slice); the director
// only uses shouldReduceMotion from it, so a minimal mock lets each scenario pick
// the reduced-motion (zero delays) or full-motion pacing.
vi.mock('@hushbox/ui', () => ({ shouldReduceMotion: (): boolean => reduceMotion }));

const { startDirector } = await import('./director');

type DirectorBackend = Parameters<typeof startDirector>[1];

const MODES: readonly DemoModality[] = ['text', 'image', 'video'];

// Titles unlike the modes' own names, so a director that looked a mode up by name finds nothing.
const MODE_TITLES: Readonly<Record<DemoModality, string>> = {
  text: 'Write',
  image: 'Picture',
  video: 'Clip',
};

interface ModeMenuOptions {
  /** The anchored menu opens on the press; the phone sheet on the click. */
  readonly opensOn: 'pointerdown' | 'click';
  /** The mode the composer is in; outside text, its chip names it. */
  readonly current?: DemoModality;
  /** Every mode but the current one stays locked. */
  readonly locked?: boolean;
}

interface FakeModeMenu {
  readonly button: HTMLButtonElement;
  /** The modes chosen in the menu, in order. */
  readonly chosen: DemoModality[];
  /** How many times the menu opened. */
  opens: number;
  /** How many times Escape closed it. */
  escapes: number;
}

/**
 * The composer's "+" and its mode menu, drawn as the app draws them: a radio
 * item per mode carrying its mode's test id, the trigger marked expanded while
 * open, and the mode chip outside text mode, named as the app names it.
 */
function mountModeMenu(options: ModeMenuOptions): FakeModeMenu {
  let current: DemoModality = options.current ?? 'text';
  const button = document.createElement('button');
  button.dataset['testid'] = TEST_IDS.modeMenuButton;
  button.setAttribute('aria-expanded', 'false');
  document.body.append(button);
  let menu: HTMLElement | null = null;
  const fake: FakeModeMenu = { button, chosen: [], opens: 0, escapes: 0 };

  let chipElement: HTMLButtonElement | null = null;
  const renderChip = (): void => {
    chipElement?.remove();
    chipElement = null;
    if (current === 'text') return;
    const chip = document.createElement('button');
    chip.setAttribute('aria-label', modeChipLabel(current));
    document.body.append(chip);
    chipElement = chip;
  };
  const close = (): void => {
    menu?.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    fake.opens += 1;
    button.setAttribute('aria-expanded', 'true');
    menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    for (const modality of MODES) {
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitemradio');
      item.dataset['testid'] = TEST_ID_BUILDERS.modeMenuItem(modality);
      item.setAttribute('aria-checked', String(modality === current));
      const title = document.createElement('span');
      title.id = `mode-title-${modality}`;
      title.textContent = MODE_TITLES[modality];
      item.setAttribute('aria-labelledby', title.id);
      item.append(title);
      const isLocked = options.locked === true && modality !== current;
      if (isLocked) item.setAttribute('aria-disabled', 'true');
      item.addEventListener('click', () => {
        if (isLocked) return;
        fake.chosen.push(modality);
        current = modality;
        renderChip();
        close();
      });
      menu.append(item);
    }
    menu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      fake.escapes += 1;
      close();
    });
    document.body.append(menu);
  };

  button.addEventListener(options.opensOn, () => {
    if (menu === null) open();
  });
  renderChip();
  return fake;
}

/** The composer, send button and message list a play drives, on the welcome screen. */
function mountChatDom(): void {
  const composer = document.createElement('textarea');
  composer.dataset['testid'] = TEST_IDS.promptInput;
  const send = document.createElement('button');
  send.dataset['testid'] = TEST_IDS.sendButton;
  const list = document.createElement('div');
  list.dataset['testid'] = TEST_IDS.messageList;
  list.setAttribute(TEST_SIGNALS.streamingCount, '0');
  const welcome = document.createElement('div');
  welcome.dataset['testid'] = TEST_IDS.chatWelcome;
  document.body.append(composer, send, list, welcome);
}

/** A router whose navigate shows the welcome screen on the new-chat route only. */
function makeRouter(): { navigate: (path: string) => void } {
  return {
    navigate: (path) => {
      const welcome = document.querySelector(`[data-testid="${TEST_IDS.chatWelcome}"]`);
      if (path === ROUTES.CHAT && welcome === null) {
        const shown = document.createElement('div');
        shown.dataset['testid'] = TEST_IDS.chatWelcome;
        document.body.append(shown);
      } else if (path !== ROUTES.CHAT) {
        welcome?.remove();
      }
    },
  };
}

function soloBackend(modality: DemoModality): DirectorBackend {
  const prompts = ['Prompt'];
  return {
    resetConversation: vi.fn(),
    fillConversation: vi.fn(),
    getModality: vi.fn(() => modality),
    peekNextUserText: vi.fn(() => prompts.shift() ?? null),
    isGroupConversation: vi.fn(() => false),
    peekNextGroupText: vi.fn(() => null),
    peekNextGroupMessage: vi.fn(() => null),
    appendNextGroupMessage: vi.fn(() => null),
  };
}

function groupBackend(): DirectorBackend {
  return {
    resetConversation: vi.fn(),
    fillConversation: vi.fn(),
    getModality: vi.fn(() => undefined),
    peekNextUserText: vi.fn(() => null),
    isGroupConversation: vi.fn(() => true),
    peekNextGroupText: vi.fn(() => 'Opener'),
    peekNextGroupMessage: vi.fn(() => null),
    appendNextGroupMessage: vi.fn(() => null),
  };
}

function play(backend: DirectorBackend): () => void {
  return startDirector(makeRouter(), backend, vi.fn(), {
    emitRealtime: vi.fn(),
    stopTurnFrames: vi.fn(),
    bootConversationId: 'conversation-1',
  });
}

describe('the director switches mode through the "+" menu', () => {
  beforeEach(() => {
    reduceMotion = true;
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('reaches image through the anchored menu, which opens on the press', async () => {
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown' });
    const dispose = play(soloBackend('image'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.chosen).toEqual(['image']);
    dispose();
  });

  it('reaches video through the phone sheet, which opens on the click', async () => {
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'click' });
    const dispose = play(soloBackend('video'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.chosen).toEqual(['video']);
    dispose();
  });

  it('leaves the menu shut when the composer is already in the mode', async () => {
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown', current: 'image' });
    const dispose = play(soloBackend('image'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.opens).toBe(0);
    dispose();
  });

  it('returns the group to text from another mode', async () => {
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown', current: 'video' });
    const dispose = play(groupBackend());
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.chosen).toEqual(['text']);
    dispose();
  });

  it('holds the open menu a beat before choosing, at full motion', async () => {
    reduceMotion = false;
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown' });
    const dispose = play(soloBackend('image'));
    await vi.advanceTimersByTimeAsync(300);

    expect(menu.opens).toBe(1);
    expect(menu.chosen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(menu.chosen).toEqual(['image']);
    dispose();
  });

  it('closes the menu when the mode stays locked', async () => {
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown', locked: true });
    const dispose = play(soloBackend('image'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.chosen).toEqual([]);
    expect(menu.escapes).toBe(1);
    expect(menu.button.getAttribute('aria-expanded')).toBe('false');
    dispose();
  });

  it('closes the menu when the play is abandoned before the choice', async () => {
    reduceMotion = false;
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown' });
    const dispose = play(soloBackend('image'));
    await vi.advanceTimersByTimeAsync(300);
    expect(menu.opens).toBe(1);

    dispose();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.chosen).toEqual([]);
    expect(menu.escapes).toBe(1);
  });

  it('leaves a disabled "+" alone', async () => {
    mountChatDom();
    const menu = mountModeMenu({ opensOn: 'pointerdown' });
    menu.button.disabled = true;
    const dispose = play(soloBackend('image'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(menu.opens).toBe(0);
    dispose();
  });
});
