import * as React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { SettingCard } from '../controls/setting-card';
import { detectDevice } from '../lib/device-detect';
import { TTS_VOICES, getTtsService, type TtsVoice } from '../lib/tts-engine';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

// Disclosure sizes are rounded approximations of the published file sizes on
// the onnx-community/Kokoro-82M-v1.0-ONNX model card. fp32 is what WebGPU
// requires for clean audio (see tts.worker.ts); q8 is the WASM default.
const DOWNLOAD_SIZE_TEXT_WEBGPU = '330 MB';
const DOWNLOAD_SIZE_TEXT_WASM = '80 MB';

async function requestPersistentStorage(): Promise<void> {
  const nav = globalThis.navigator as unknown as {
    storage?: { persist?: () => Promise<boolean> };
  };
  const persist = nav.storage?.persist;
  if (persist === undefined) return;
  try {
    await persist.call(nav.storage);
  } catch {
    // Quota request denial is non-fatal; the cached model still works.
  }
}

function ReadAloudControls(): React.JSX.Element {
  const ttsEnabled = useA11yStore((s) => s.ttsEnabled);
  const ttsVoice = useA11yStore((s) => s.ttsVoice);
  const streamChatAloud = useA11yStore((s) => s.streamChatAloud);
  const update = useA11yStore((s) => s.update);
  const [downloading, setDownloading] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // detectDevice() does an async navigator.gpu.requestAdapter() round-trip,
  // so the disclosure starts at the conservative WASM size and upgrades to
  // the fp32 size if WebGPU is genuinely available. The brief flicker is
  // acceptable: the user only sees this panel, not a loading-critical path.
  const [detectedDevice, setDetectedDevice] = React.useState<'webgpu' | 'wasm'>('wasm');
  React.useEffect(() => {
    let cancelled = false;
    void detectDevice().then((device) => {
      if (!cancelled) setDetectedDevice(device);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const downloadSizeText =
    detectedDevice === 'webgpu' ? DOWNLOAD_SIZE_TEXT_WEBGPU : DOWNLOAD_SIZE_TEXT_WASM;

  const handleToggle = React.useCallback(
    (value: 'on' | 'off'): void => {
      if (value === 'off') {
        update({ streamChatAloud: false });
        return;
      }
      if (ttsEnabled) {
        update({ streamChatAloud: true });
        return;
      }
      // First-time enable: download the on-device model, then turn chat-aloud on.
      void (async (): Promise<void> => {
        setDownloading(true);
        setError(null);
        setProgress(null);
        try {
          const service = getTtsService();
          await service.load(ttsVoice, (loaded, total) => {
            if (total > 0) {
              setProgress(Math.min(100, Math.round((loaded / total) * 100)));
            }
          });
          await requestPersistentStorage();
          update({ ttsEnabled: true, streamChatAloud: true });
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : 'Download failed');
        } finally {
          setDownloading(false);
        }
      })();
    },
    [ttsEnabled, ttsVoice, update]
  );

  // Voice changes after the model is loaded: re-warm with the new voice so
  // the next speak() doesn't pay the embedding-fetch round-trip. Skipped on
  // first mount of an already-enabled session — the model is already warm
  // with whatever voice was used last; only changes need a preload.
  const previousVoiceRef = React.useRef<TtsVoice | null>(null);
  React.useEffect(() => {
    const previousVoice = previousVoiceRef.current;
    previousVoiceRef.current = ttsVoice;
    if (!ttsEnabled) return;
    if (previousVoice === null) return;
    if (previousVoice === ttsVoice) return;
    void getTtsService()
      .preloadVoice(ttsVoice)
      .catch((preloadError: unknown) => {
        console.error('TTS voice preload failed:', preloadError);
      });
  }, [ttsEnabled, ttsVoice]);

  return (
    <div className="flex flex-col gap-2">
      <SettingCard
        title="Read chat replies aloud"
        options={ON_OFF_OPTIONS}
        value={streamChatAloud ? 'on' : 'off'}
        onChange={handleToggle}
      />
      <p className="text-muted-foreground text-xs">
        {downloadSizeText}, one-time download. Runs entirely on your device. No audio or text ever
        leaves this device.
      </p>
      {downloading && progress !== null ? (
        <div
          role="progressbar"
          aria-label="Read-aloud model download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="bg-input h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full transition-all"
            style={{ width: `${String(progress)}%` }}
          />
        </div>
      ) : null}
      {downloading && progress === null ? (
        <div
          role="progressbar"
          aria-label="Read-aloud model download"
          className="bg-input h-2 w-full animate-pulse overflow-hidden rounded-full"
        />
      ) : null}
      {error === null ? null : (
        <div role="alert" className="text-destructive text-xs">
          Could not download the read-aloud model: {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
        <span id="a11y-voice-label">Voice</span>
        <Select
          value={ttsVoice}
          onValueChange={(value) => {
            update({ ttsVoice: value as TtsVoice });
          }}
        >
          <SelectTrigger aria-labelledby="a11y-voice-label" className="w-[22rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TTS_VOICES.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                {voice.displayName} ({voice.accent}, {voice.gender})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function AudioSection(): React.JSX.Element {
  const muteSounds = useA11yStore((s) => s.muteSounds);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-audio-heading" className="flex flex-col gap-3">
      <h2 id="a11y-audio-heading" className="text-lg font-semibold">
        Sound
      </h2>
      <SettingCard
        title="Mute all sounds"
        options={ON_OFF_OPTIONS}
        value={muteSounds ? 'on' : 'off'}
        onChange={(v) => {
          update({ muteSounds: v === 'on' });
        }}
      />
      <ReadAloudControls />
    </section>
  );
}
