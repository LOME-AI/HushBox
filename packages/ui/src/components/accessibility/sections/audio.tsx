import * as React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { SettingCard } from '../controls/setting-card';
import {
  DownloadRateTracker,
  estimateEtaSeconds,
  formatBytesProgress,
  formatEta,
  formatSpeed,
} from '../lib/tts-download-progress';
import { TTS_VOICES, getTtsService, type TtsVoice } from '../lib/tts-engine';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

// Rounded approximation of the q8 weights' size on the
// onnx-community/Kokoro-82M-v1.0-ONNX model card. Multiplied by
// WORKER_POOL_SIZE workers on disk after first load, but the HF
// transformers IndexedDB cache deduplicates by URL so the download is
// paid once.
const DOWNLOAD_SIZE_TEXT = '80 MB';

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
  const [bytes, setBytes] = React.useState<{ loaded: number; total: number } | null>(null);
  const [bytesPerSecond, setBytesPerSecond] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const rateTrackerRef = React.useRef<DownloadRateTracker | null>(null);

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
        setBytes(null);
        setBytesPerSecond(null);
        const tracker = new DownloadRateTracker();
        rateTrackerRef.current = tracker;
        try {
          const service = getTtsService();
          await service.load(ttsVoice, (loaded, total) => {
            if (total <= 0) return;
            tracker.record(loaded, Date.now());
            setBytes({ loaded, total });
            setBytesPerSecond(tracker.bytesPerSecond());
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
    void (async (): Promise<void> => {
      try {
        await getTtsService().preloadVoice(ttsVoice);
      } catch (preloadError: unknown) {
        console.error('TTS voice preload failed:', preloadError);
      }
    })();
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
        {DOWNLOAD_SIZE_TEXT}, one-time download. Runs entirely on your device. No audio or text ever
        leaves this device.
      </p>
      {downloading && bytes !== null ? (
        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-label="Read-aloud model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round((bytes.loaded / bytes.total) * 100))}
            className="bg-input h-2 w-full overflow-hidden rounded-full"
          >
            <div
              className="bg-primary h-full transition-all"
              style={{
                width: `${String(Math.min(100, Math.round((bytes.loaded / bytes.total) * 100)))}%`,
              }}
            />
          </div>
          <p className="text-muted-foreground text-xs tabular-nums">
            {formatBytesProgress(bytes.loaded, bytes.total)}
            {bytesPerSecond === null ? '' : ` · ${formatSpeed(bytesPerSecond)}`}
            {(() => {
              if (bytesPerSecond === null) return '';
              const eta = estimateEtaSeconds(bytes.loaded, bytes.total, bytesPerSecond);
              if (eta === null || eta <= 0) return '';
              return ` · ${formatEta(eta)}`;
            })()}
          </p>
        </div>
      ) : null}
      {downloading && bytes === null ? (
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
