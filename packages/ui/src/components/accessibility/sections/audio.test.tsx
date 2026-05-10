import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the TTS engine so the heavy ONNX model never loads in tests.
// Replace the entire module so kokoro-js (and its phonemizer / espeak data
// blob) never resolves at test import time. TTS_VOICES is duplicated here
// because vi.importActual would still pull the real module's transitive
// kokoro-js import.
const { loadMock, isLoadedMock, speakMock, stopMock, unlockAudioMock, TTS_VOICES_MOCK } =
  vi.hoisted(() => ({
    loadMock: vi.fn(),
    isLoadedMock: vi.fn(),
    speakMock: vi.fn(),
    stopMock: vi.fn(),
    unlockAudioMock: vi.fn(),
    TTS_VOICES_MOCK: [
      { id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' },
      { id: 'am_michael', displayName: 'Michael', accent: 'American', gender: 'male' },
      { id: 'bf_emma', displayName: 'Emma', accent: 'British', gender: 'female' },
      { id: 'bm_george', displayName: 'George', accent: 'British', gender: 'male' },
      { id: 'af_nicole', displayName: 'Nicole', accent: 'American', gender: 'female' },
    ] as const,
  }));

vi.mock('../lib/tts-engine', () => ({
  TTS_VOICES: TTS_VOICES_MOCK,
  getTtsService: () => ({
    load: loadMock,
    isLoaded: isLoadedMock,
    speak: speakMock,
    stop: stopMock,
    unlockAudio: unlockAudioMock,
  }),
}));

import { AudioSection } from './audio';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';

interface StorageManagerLike {
  persist?: () => Promise<boolean>;
}
// Mutable bag indexed by 'storage' so we can reassign / delete without
// fighting the read-only StorageManager intersection on Navigator.
interface StorageBag {
  storage: StorageManagerLike | undefined;
}
const storageBag = globalThis.navigator as unknown as StorageBag;

describe('AudioSection', () => {
  let originalStorage: StorageManagerLike | undefined;

  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    loadMock.mockReset();
    isLoadedMock.mockReset();
    speakMock.mockReset();
    stopMock.mockReset();
    unlockAudioMock.mockReset();
    // eslint-disable-next-line unicorn/no-useless-undefined -- vitest mockResolvedValue requires explicit void value
    loadMock.mockResolvedValue(undefined);
    isLoadedMock.mockReturnValue(false);
    originalStorage = storageBag.storage;
    storageBag.storage = {
      persist: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    storageBag.storage = originalStorage;
  });

  describe('rendering — common to both gate states', () => {
    it('renders the Audio section heading', () => {
      render(<AudioSection />);
      expect(screen.getByRole('heading', { name: /audio/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(<AudioSection />);
      const section = container.querySelector('section');
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /audio/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders the Mute all sounds switch when TTS is disabled', () => {
      render(<AudioSection />);
      expect(screen.getByRole('switch', { name: /mute all sounds/i })).toBeInTheDocument();
    });

    it('renders the Mute all sounds switch when TTS is enabled', () => {
      useA11yStore.setState({ ttsEnabled: true });
      render(<AudioSection />);
      expect(screen.getByRole('switch', { name: /mute all sounds/i })).toBeInTheDocument();
    });
  });

  describe('gate (ttsEnabled=false)', () => {
    it('shows the Enable read-aloud button with the download size copy', () => {
      render(<AudioSection />);
      expect(
        screen.getByRole('button', { name: /enable read-aloud.*100 ?mb.*one-time download/i })
      ).toBeInTheDocument();
    });

    it('shows the on-device privacy copy', () => {
      render(<AudioSection />);
      expect(
        screen.getByText(/runs entirely on your device.*no audio or text ever leaves this device/i)
      ).toBeInTheDocument();
    });

    it('does not render the voice picker when TTS is disabled', () => {
      render(<AudioSection />);
      expect(screen.queryByRole('combobox', { name: /voice/i })).not.toBeInTheDocument();
    });

    it('does not render the Stream chat aloud switch when TTS is disabled', () => {
      render(<AudioSection />);
      expect(screen.queryByRole('switch', { name: /stream chat aloud/i })).not.toBeInTheDocument();
    });

    it('does not render the Read page button when TTS is disabled', () => {
      render(<AudioSection />);
      expect(screen.queryByRole('button', { name: /^read page$/i })).not.toBeInTheDocument();
    });

    it('does not render the Read selection button when TTS is disabled', () => {
      render(<AudioSection />);
      expect(screen.queryByRole('button', { name: /^read selection$/i })).not.toBeInTheDocument();
    });
  });

  describe('gate — clicking Enable read-aloud', () => {
    it('calls the TTS engine load() method', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      await waitFor(() => {
        expect(loadMock).toHaveBeenCalledTimes(1);
      });
    });

    it('disables the button while downloading', async () => {
      let resolveLoad!: () => void;
      loadMock.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
      );
      const user = userEvent.setup();
      render(<AudioSection />);
      const button = screen.getByRole('button', { name: /enable read-aloud/i });
      await user.click(button);
      await waitFor(() => {
        expect(button).toBeDisabled();
      });
      resolveLoad();
      await waitFor(() => {
        expect(useA11yStore.getState().ttsEnabled).toBe(true);
      });
    });

    it('shows a progress bar while downloading', async () => {
      let resolveLoad!: () => void;
      loadMock.mockImplementation((onProgress?: (loaded: number, total: number) => void) => {
        return new Promise<void>((resolve) => {
          resolveLoad = resolve;
          // Simulate a progress event mid-download.
          setTimeout(() => {
            onProgress?.(40, 100);
          }, 0);
        });
      });
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      const progressBar = await screen.findByRole('progressbar');
      await waitFor(() => {
        expect(progressBar).toHaveAttribute('aria-valuenow', '40');
      });
      resolveLoad();
      await waitFor(() => {
        expect(useA11yStore.getState().ttsEnabled).toBe(true);
      });
    });

    it('on success, sets ttsEnabled=true in the store', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      await waitFor(() => {
        expect(useA11yStore.getState().ttsEnabled).toBe(true);
      });
    });

    it('on success, calls navigator.storage.persist()', async () => {
      const persistMock = vi.fn().mockResolvedValue(true);
      storageBag.storage = { persist: persistMock };
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      await waitFor(() => {
        expect(persistMock).toHaveBeenCalledTimes(1);
      });
    });

    it('still sets ttsEnabled=true even if navigator.storage is unsupported', async () => {
      storageBag.storage = undefined;
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      await waitFor(() => {
        expect(useA11yStore.getState().ttsEnabled).toBe(true);
      });
    });

    it('still sets ttsEnabled=true even if navigator.storage.persist() rejects', async () => {
      storageBag.storage = {
        persist: vi.fn().mockRejectedValue(new Error('quota request denied')),
      };
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      await waitFor(() => {
        expect(useA11yStore.getState().ttsEnabled).toBe(true);
      });
    });

    it('on download failure, surfaces an error message and leaves ttsEnabled=false', async () => {
      loadMock.mockRejectedValueOnce(new Error('network down'));
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      const alert = await screen.findByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(useA11yStore.getState().ttsEnabled).toBe(false);
    });

    it('after download failure, the button becomes enabled again so the user can retry', async () => {
      loadMock.mockRejectedValueOnce(new Error('network down'));
      const user = userEvent.setup();
      render(<AudioSection />);
      const button = screen.getByRole('button', { name: /enable read-aloud/i });
      await user.click(button);
      await screen.findByRole('alert');
      await waitFor(() => {
        expect(button).not.toBeDisabled();
      });
    });

    it('ignores progress events with total=0 (avoids divide-by-zero)', async () => {
      let resolveLoad!: () => void;
      loadMock.mockImplementation((onProgress?: (loaded: number, total: number) => void) => {
        return new Promise<void>((resolve) => {
          resolveLoad = resolve;
          setTimeout(() => {
            // total=0 must not crash and must not render a 0% bar.
            onProgress?.(10, 0);
          }, 0);
        });
      });
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      // Indeterminate bar (no aria-valuenow) is still acceptable here.
      await screen.findByRole('progressbar');
      const determinate = screen.queryByRole('progressbar', { name: /read-aloud/i });
      // Whichever bar exists must not be reporting "0" — it should remain indeterminate.
      expect(determinate?.getAttribute('aria-valuenow')).toBeFalsy();
      resolveLoad();
      await waitFor(() => {
        expect(useA11yStore.getState().ttsEnabled).toBe(true);
      });
    });

    it('surfaces a generic message when load() rejects with a non-Error value', async () => {
      loadMock.mockRejectedValueOnce('plain string thrown');
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /enable read-aloud/i }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/download failed/i);
      expect(useA11yStore.getState().ttsEnabled).toBe(false);
    });
  });

  describe('controls (ttsEnabled=true)', () => {
    beforeEach(() => {
      useA11yStore.setState({ ttsEnabled: true });
    });

    it('does not render the Enable read-aloud button when TTS is enabled', () => {
      render(<AudioSection />);
      expect(screen.queryByRole('button', { name: /enable read-aloud/i })).not.toBeInTheDocument();
    });

    it('renders the Read page button', () => {
      render(<AudioSection />);
      expect(screen.getByRole('button', { name: /^read page$/i })).toBeInTheDocument();
    });

    it('renders the Read selection button', () => {
      render(<AudioSection />);
      expect(screen.getByRole('button', { name: /^read selection$/i })).toBeInTheDocument();
    });

    it('Read page button is clickable (no-op placeholder until wired up)', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      // Should not throw and should not change any store state.
      await user.click(screen.getByRole('button', { name: /^read page$/i }));
      expect(useA11yStore.getState().ttsEnabled).toBe(true);
    });

    it('Read selection button is clickable (no-op placeholder until wired up)', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('button', { name: /^read selection$/i }));
      expect(useA11yStore.getState().ttsEnabled).toBe(true);
    });

    it('renders the Stream chat aloud switch', () => {
      render(<AudioSection />);
      expect(screen.getByRole('switch', { name: /stream chat aloud/i })).toBeInTheDocument();
    });

    it('toggling Stream chat aloud updates the store', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('switch', { name: /stream chat aloud/i }));
      expect(useA11yStore.getState().streamChatAloud).toBe(true);
    });

    it('Stream chat aloud reflects current store state', () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      render(<AudioSection />);
      expect(screen.getByRole('switch', { name: /stream chat aloud/i })).toBeChecked();
    });

    it('renders the voice picker', () => {
      render(<AudioSection />);
      expect(screen.getByRole('combobox', { name: /voice/i })).toBeInTheDocument();
    });

    it('voice picker exposes all five TTS voices', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('combobox', { name: /voice/i }));
      await waitFor(() => {
        for (const voice of TTS_VOICES_MOCK) {
          // Display name appears in the option label.
          expect(screen.getAllByText(new RegExp(voice.displayName, 'i')).length).toBeGreaterThan(0);
        }
      });
    });

    it('voice picker shows the currently-selected voice', () => {
      useA11yStore.setState({ ttsEnabled: true, ttsVoice: 'bm_george' });
      render(<AudioSection />);
      const trigger = screen.getByRole('combobox', { name: /voice/i });
      expect(trigger).toHaveTextContent(/george/i);
    });

    it('selecting a voice updates the store', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('combobox', { name: /voice/i }));
      await waitFor(() => {
        expect(screen.getByText(/michael/i)).toBeInTheDocument();
      });
      await user.click(screen.getByText(/michael/i));
      await waitFor(() => {
        expect(useA11yStore.getState().ttsVoice).toBe('am_michael');
      });
    });
  });

  describe('Mute all sounds — independent of TTS gate', () => {
    it('toggling Mute all sounds updates the store with TTS disabled', async () => {
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('switch', { name: /mute all sounds/i }));
      expect(useA11yStore.getState().muteSounds).toBe(true);
    });

    it('toggling Mute all sounds updates the store with TTS enabled', async () => {
      useA11yStore.setState({ ttsEnabled: true });
      const user = userEvent.setup();
      render(<AudioSection />);
      await user.click(screen.getByRole('switch', { name: /mute all sounds/i }));
      expect(useA11yStore.getState().muteSounds).toBe(true);
    });

    it('reflects current store state for Mute all sounds', () => {
      useA11yStore.setState({ muteSounds: true });
      render(<AudioSection />);
      expect(screen.getByRole('switch', { name: /mute all sounds/i })).toBeChecked();
    });
  });
});
