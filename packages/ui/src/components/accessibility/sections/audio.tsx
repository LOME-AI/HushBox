import * as React from 'react';

import { Button } from '../../button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { SettingCard } from '../controls/setting-card';
import { TTS_VOICES, getTtsService, type TtsVoice } from '../lib/tts-engine';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

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

interface TtsGateProps {
  onEnabled: () => void;
}

function TtsGate({ onEnabled }: Readonly<TtsGateProps>): React.JSX.Element {
  const [downloading, setDownloading] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleClick = React.useCallback(async (): Promise<void> => {
    setDownloading(true);
    setError(null);
    setProgress(null);
    try {
      const service = getTtsService();
      await service.load((loaded, total) => {
        if (total > 0) {
          setProgress(Math.min(100, Math.round((loaded / total) * 100)));
        }
      });
      await requestPersistentStorage();
      onEnabled();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Download failed';
      setError(message);
      setDownloading(false);
    }
  }, [onEnabled]);

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={downloading}
        onClick={() => {
          void handleClick();
        }}
      >
        Turn on read-aloud — about 80 MB, one-time download
      </Button>
      <p className="text-muted-foreground text-xs">
        Runs entirely on your device. No audio or text ever leaves this device.
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
    </div>
  );
}

function ReadAloudControls(): React.JSX.Element {
  const ttsVoice = useA11yStore((s) => s.ttsVoice);
  const streamChatAloud = useA11yStore((s) => s.streamChatAloud);
  const update = useA11yStore((s) => s.update);

  return (
    <div className="flex flex-col gap-2">
      <SettingCard
        title="Read chat replies aloud"
        options={ON_OFF_OPTIONS}
        value={streamChatAloud ? 'on' : 'off'}
        onChange={(v) => {
          update({ streamChatAloud: v === 'on' });
        }}
      />
      <div className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
        <span id="a11y-voice-label">Voice</span>
        <Select
          value={ttsVoice}
          onValueChange={(value) => {
            update({ ttsVoice: value as TtsVoice });
          }}
        >
          <SelectTrigger aria-labelledby="a11y-voice-label" className="w-44">
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
  const ttsEnabled = useA11yStore((s) => s.ttsEnabled);
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
      {ttsEnabled ? (
        <ReadAloudControls />
      ) : (
        <TtsGate
          onEnabled={() => {
            update({ ttsEnabled: true });
          }}
        />
      )}
    </section>
  );
}
