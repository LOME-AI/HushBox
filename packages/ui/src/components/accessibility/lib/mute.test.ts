import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installMutePauser } from './mute';

describe('installMutePauser', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    cleanup = undefined;
  });

  afterEach(() => {
    cleanup?.();
    document.body.innerHTML = '';
  });

  function flushMutations(): Promise<void> {
    // MutationObserver callbacks fire on a microtask. Awaiting a resolved
    // Promise yields back after the queued microtasks have run.
    return Promise.resolve();
  }

  it('mutes existing <audio> elements on install', () => {
    const audio = document.createElement('audio');
    document.body.append(audio);
    expect(audio.muted).toBe(false);

    cleanup = installMutePauser();

    expect(audio.muted).toBe(true);
  });

  it('mutes existing <video> elements on install', () => {
    const video = document.createElement('video');
    document.body.append(video);
    expect(video.muted).toBe(false);

    cleanup = installMutePauser();

    expect(video.muted).toBe(true);
  });

  it('mutes a freshly inserted <audio> element via MutationObserver', async () => {
    cleanup = installMutePauser();

    const audio = document.createElement('audio');
    document.body.append(audio);

    await flushMutations();

    expect(audio.muted).toBe(true);
  });

  it('mutes a freshly inserted <video> element via MutationObserver', async () => {
    cleanup = installMutePauser();

    const video = document.createElement('video');
    document.body.append(video);

    await flushMutations();

    expect(video.muted).toBe(true);
  });

  it('mutes media nested inside a newly inserted subtree', async () => {
    cleanup = installMutePauser();

    const wrapper = document.createElement('div');
    const audio = document.createElement('audio');
    const video = document.createElement('video');
    wrapper.append(audio);
    wrapper.append(video);
    document.body.append(wrapper);

    await flushMutations();

    expect(audio.muted).toBe(true);
    expect(video.muted).toBe(true);
  });

  it('ignores non-Element nodes added to the DOM', async () => {
    cleanup = installMutePauser();

    // Inserting a text node should not throw and should be ignored cleanly.
    const text = document.createTextNode('hello');
    document.body.append(text);

    await flushMutations();

    expect(text.nodeType).toBe(Node.TEXT_NODE);
  });

  it('cleanup restores muted state to its original value', () => {
    const audio = document.createElement('audio');
    audio.muted = false;
    document.body.append(audio);

    cleanup = installMutePauser();
    expect(audio.muted).toBe(true);

    cleanup();
    cleanup = undefined;

    expect(audio.muted).toBe(false);
  });

  it('cleanup preserves an originally-muted element as muted', () => {
    const audio = document.createElement('audio');
    audio.muted = true;
    document.body.append(audio);

    cleanup = installMutePauser();
    expect(audio.muted).toBe(true);

    cleanup();
    cleanup = undefined;

    expect(audio.muted).toBe(true);
  });

  it('cleanup disconnects the observer — media added after cleanup is not muted', async () => {
    cleanup = installMutePauser();
    cleanup();
    cleanup = undefined;

    const audio = document.createElement('audio');
    document.body.append(audio);

    await flushMutations();

    expect(audio.muted).toBe(false);
  });

  it('invokes the onMute callback exactly once on install', () => {
    const onMute = vi.fn();

    cleanup = installMutePauser({ onMute });

    expect(onMute).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onMute when not provided (no throw)', () => {
    expect(() => {
      cleanup = installMutePauser();
    }).not.toThrow();
  });

  it('does not invoke onMute on cleanup', () => {
    const onMute = vi.fn();

    cleanup = installMutePauser({ onMute });
    onMute.mockClear();
    cleanup();
    cleanup = undefined;

    expect(onMute).not.toHaveBeenCalled();
  });

  it('returns a cleanup function', () => {
    cleanup = installMutePauser();
    expect(typeof cleanup).toBe('function');
  });

  it('handles multiple mutations in a single tick', async () => {
    cleanup = installMutePauser();

    const a1 = document.createElement('audio');
    const a2 = document.createElement('audio');
    const v1 = document.createElement('video');
    document.body.append(a1);
    document.body.append(a2);
    document.body.append(v1);

    await flushMutations();

    expect(a1.muted).toBe(true);
    expect(a2.muted).toBe(true);
    expect(v1.muted).toBe(true);
  });

  it('cleanup leaves untracked media untouched (no entry in the WeakMap)', () => {
    cleanup = installMutePauser();

    // Insert a media element AFTER install but synchronously call cleanup
    // BEFORE the MutationObserver microtask fires. The observer never sees it,
    // so the WeakMap has no entry and cleanup must not modify its state.
    const audio = document.createElement('audio');
    audio.muted = false;
    document.body.append(audio);

    cleanup();
    cleanup = undefined;

    expect(audio.muted).toBe(false);
  });

  it('preserves the originally-recorded state when the same element is re-encountered', async () => {
    const audio = document.createElement('audio');
    audio.muted = false;
    document.body.append(audio);

    cleanup = installMutePauser();
    expect(audio.muted).toBe(true);

    // Detach, flip user-visible state to true, then re-attach. The observer
    // sees an "added node" again and runs muteElement a second time; the
    // `previouslyMuted.has(...)` true-branch must keep the *first* recorded
    // value (false) so cleanup later restores false, not true.
    audio.remove();
    audio.muted = true;
    document.body.append(audio);
    await flushMutations();

    expect(audio.muted).toBe(true);

    cleanup();
    cleanup = undefined;

    expect(audio.muted).toBe(false);
  });

  it('cleanup restores all tracked elements regardless of insertion order', async () => {
    const preexisting = document.createElement('audio');
    preexisting.muted = false;
    document.body.append(preexisting);

    cleanup = installMutePauser();

    const inserted = document.createElement('video');
    document.body.append(inserted);

    await flushMutations();

    expect(preexisting.muted).toBe(true);
    expect(inserted.muted).toBe(true);

    cleanup();
    cleanup = undefined;

    expect(preexisting.muted).toBe(false);
    // `inserted` was never seen pre-mute, so its prior state was the default
    // (false). Cleanup restores it to that value.
    expect(inserted.muted).toBe(false);
  });
});
