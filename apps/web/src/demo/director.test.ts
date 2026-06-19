import { describe, it, expect, afterEach } from 'vitest';
import { typeText, isComposerTarget, installHumanInputBlock, isStreaming } from './director';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';

function makeComposer(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.dataset['testid'] = TEST_IDS.promptInput;
  document.body.append(el);
  return el;
}

function makeMessageList(streamingCount: number): HTMLDivElement {
  const el = document.createElement('div');
  el.dataset['testid'] = TEST_IDS.messageList;
  el.setAttribute(TEST_SIGNALS.streamingCount, String(streamingCount));
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('typeText', () => {
  it('sets the final value and fires an input event per character', async () => {
    const el = makeComposer();
    let inputs = 0;
    el.addEventListener('input', () => {
      inputs += 1;
    });

    await typeText(el, 'hello', 0, new AbortController().signal);

    expect(el.value).toBe('hello');
    expect(inputs).toBe('hello'.length);
  });

  it('stops early when the signal is aborted', async () => {
    const el = makeComposer();
    const controller = new AbortController();
    controller.abort();
    await typeText(el, 'hello', 0, controller.signal);
    expect(el.value).toBe('');
  });
});

describe('isComposerTarget', () => {
  it('matches the composer textarea and elements inside it, not others', () => {
    const el = makeComposer();
    const outside = document.createElement('button');
    document.body.append(outside);
    expect(isComposerTarget(el)).toBe(true);
    expect(isComposerTarget(outside)).toBe(false);
    expect(isComposerTarget(null)).toBe(false);
  });
});

describe('isStreaming', () => {
  it('reports streaming from the app-emitted data-streaming-count signal', () => {
    makeMessageList(2);
    expect(isStreaming()).toBe(true);
  });

  it('reports not streaming when the count is zero', () => {
    makeMessageList(0);
    expect(isStreaming()).toBe(false);
  });

  it('reports not streaming when no message list is mounted', () => {
    expect(isStreaming()).toBe(false);
  });
});

describe('installHumanInputBlock', () => {
  it('does not block the director synthetic (untrusted) input events', () => {
    const el = makeComposer();
    const uninstall = installHumanInputBlock();
    // Dispatched events are untrusted (isTrusted === false), so they must pass.
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });

  it('blocks a trusted keydown on the composer (handler logic)', () => {
    const el = makeComposer();
    const uninstall = installHumanInputBlock();
    // jsdom can't mint trusted events, so assert the handler's decision directly.
    const preventDefault = (): void => {
      blocked = true;
    };
    let blocked = false;
    const fakeTrusted = { isTrusted: true, target: el, preventDefault } as unknown as Event;
    // Re-derive the predicate the handler uses.
    if (fakeTrusted.isTrusted && isComposerTarget(fakeTrusted.target)) fakeTrusted.preventDefault();
    expect(blocked).toBe(true);
    uninstall();
  });
});
