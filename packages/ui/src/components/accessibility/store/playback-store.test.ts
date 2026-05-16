import { describe, it, expect, beforeEach } from 'vitest';
import { createTtsPlaybackStore, useTtsPlaybackStore } from './playback-store';

describe('createTtsPlaybackStore', () => {
  describe('initial state', () => {
    it('starts with no speaking stream', () => {
      const store = createTtsPlaybackStore();
      expect(store.getState().speakingStreamId).toBeNull();
    });

    it('starts with an empty stoppedStreamIds set', () => {
      const store = createTtsPlaybackStore();
      expect(store.getState().stoppedStreamIds.size).toBe(0);
    });

    it('exposes action handlers', () => {
      const store = createTtsPlaybackStore();
      const state = store.getState();
      expect(typeof state.setSpeakingStream).toBe('function');
      expect(typeof state.clearSpeakingStreamIfMatches).toBe('function');
      expect(typeof state.markStreamStopped).toBe('function');
    });
  });

  describe('setSpeakingStream', () => {
    it('sets the active speaking stream id', () => {
      const store = createTtsPlaybackStore();
      store.getState().setSpeakingStream('msg-1');
      expect(store.getState().speakingStreamId).toBe('msg-1');
    });

    it('overwrites a prior speaking stream id', () => {
      const store = createTtsPlaybackStore();
      store.getState().setSpeakingStream('msg-1');
      store.getState().setSpeakingStream('msg-2');
      expect(store.getState().speakingStreamId).toBe('msg-2');
    });
  });

  describe('clearSpeakingStreamIfMatches', () => {
    it('clears the speaking stream when the id matches', () => {
      const store = createTtsPlaybackStore();
      store.getState().setSpeakingStream('msg-1');
      store.getState().clearSpeakingStreamIfMatches('msg-1');
      expect(store.getState().speakingStreamId).toBeNull();
    });

    it('leaves the speaking stream untouched when the id does not match', () => {
      const store = createTtsPlaybackStore();
      store.getState().setSpeakingStream('msg-1');
      store.getState().clearSpeakingStreamIfMatches('msg-other');
      expect(store.getState().speakingStreamId).toBe('msg-1');
    });

    it('is a no-op when no stream is currently speaking', () => {
      const store = createTtsPlaybackStore();
      store.getState().clearSpeakingStreamIfMatches('msg-1');
      expect(store.getState().speakingStreamId).toBeNull();
    });
  });

  describe('markStreamStopped', () => {
    it('adds the id to stoppedStreamIds', () => {
      const store = createTtsPlaybackStore();
      store.getState().markStreamStopped('msg-1');
      expect(store.getState().stoppedStreamIds.has('msg-1')).toBe(true);
    });

    it('accumulates multiple stopped stream ids', () => {
      const store = createTtsPlaybackStore();
      store.getState().markStreamStopped('msg-1');
      store.getState().markStreamStopped('msg-2');
      const stopped = store.getState().stoppedStreamIds;
      expect(stopped.has('msg-1')).toBe(true);
      expect(stopped.has('msg-2')).toBe(true);
    });

    it('clears speakingStreamId when it matches the stopped id', () => {
      const store = createTtsPlaybackStore();
      store.getState().setSpeakingStream('msg-1');
      store.getState().markStreamStopped('msg-1');
      expect(store.getState().speakingStreamId).toBeNull();
    });

    it('leaves a non-matching speakingStreamId untouched', () => {
      const store = createTtsPlaybackStore();
      store.getState().setSpeakingStream('msg-1');
      store.getState().markStreamStopped('msg-2');
      expect(store.getState().speakingStreamId).toBe('msg-1');
      expect(store.getState().stoppedStreamIds.has('msg-2')).toBe(true);
    });

    it('produces a new Set instance so React subscribers re-render', () => {
      const store = createTtsPlaybackStore();
      const before = store.getState().stoppedStreamIds;
      store.getState().markStreamStopped('msg-1');
      const after = store.getState().stoppedStreamIds;
      expect(after).not.toBe(before);
    });
  });
});

describe('useTtsPlaybackStore (default singleton)', () => {
  beforeEach(() => {
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
    });
  });

  it('exposes the same shape as createTtsPlaybackStore', () => {
    const state = useTtsPlaybackStore.getState();
    expect(state.speakingStreamId).toBeNull();
    expect(state.stoppedStreamIds.size).toBe(0);
    expect(typeof state.setSpeakingStream).toBe('function');
  });

  it('mutates singleton state via actions', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('singleton-msg');
    expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('singleton-msg');
  });

  it('does not persist to localStorage', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('singleton-msg');
    const keys = Object.keys(globalThis.window.localStorage);
    const playbackKeys = keys.filter((k) => k.toLowerCase().includes('playback'));
    expect(playbackKeys).toEqual([]);
  });
});
