import * as React from 'react';
import { Button } from '@hushbox/ui';
import {
  IMAGE_ASPECT_RATIOS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  MIN_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_DURATION_SECONDS,
  AUDIO_FORMATS,
  MAX_AUDIO_DURATION_SECONDS,
} from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useMediaCostEstimate } from '@/hooks/use-media-cost-estimate';
import type { Model } from '@hushbox/shared';

interface TogglePillProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function TogglePill({ label, isActive, onClick }: Readonly<TogglePillProps>): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      onClick={onClick}
      className="w-28 whitespace-nowrap"
    >
      {label}
    </Button>
  );
}

export function ImageAspectRatioControl(): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.imageConfig.aspectRatio);
  const setImageConfig = useModelStore((s) => s.setImageConfig);

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Aspect ratio</legend>
      {IMAGE_ASPECT_RATIOS.map((ratio) => (
        <TogglePill
          key={ratio}
          label={ratio}
          isActive={aspectRatio === ratio}
          onClick={() => {
            setImageConfig({ aspectRatio: ratio });
          }}
        />
      ))}
    </fieldset>
  );
}

export function VideoAspectRatioControl(): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.videoConfig.aspectRatio);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Aspect ratio</legend>
      {VIDEO_ASPECT_RATIOS.map((ratio) => (
        <TogglePill
          key={ratio}
          label={ratio}
          isActive={aspectRatio === ratio}
          onClick={() => {
            setVideoConfig({ aspectRatio: ratio });
          }}
        />
      ))}
    </fieldset>
  );
}

type SupportedResolution = (typeof VIDEO_RESOLUTIONS)[number];

/**
 * Resolutions the primary selected video model supports, in canonical order.
 * Returns an empty list when no model is selected or the selected model has no
 * per-resolution pricing; the control then shows a hint instead of toggle buttons
 * so users don't see resolutions the backend will reject.
 */
function supportedResolutionsFor(model: Model | undefined): readonly SupportedResolution[] {
  if (!model) return [];
  const keys = Object.keys(model.pricePerSecondByResolution);
  if (keys.length === 0) return [];
  return VIDEO_RESOLUTIONS.filter((r) => keys.includes(r));
}

export function VideoResolutionControl(): React.JSX.Element {
  const resolution = useModelStore((s) => s.videoConfig.resolution);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const primaryModel = data?.models.find((m) => m.id === selectedModels[0]?.id);
  const supportedResolutions = supportedResolutionsFor(primaryModel);
  const priceByRes = primaryModel?.pricePerSecondByResolution ?? {};

  React.useEffect(() => {
    const first = supportedResolutions[0];
    if (first === undefined) return;
    if (!supportedResolutions.includes(resolution)) {
      setVideoConfig({ resolution: first });
    }
  }, [supportedResolutions, resolution, setVideoConfig]);

  if (supportedResolutions.length === 0) {
    return (
      <div className="text-muted-foreground text-xs italic">
        Select a video model to see resolution options.
      </div>
    );
  }

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Resolution</legend>
      {supportedResolutions.map((res) => {
        const price = priceByRes[res] ?? 0;
        const label = `${res} $${price.toFixed(2)}/s`;
        return (
          <TogglePill
            key={res}
            label={label}
            isActive={resolution === res}
            onClick={() => {
              setVideoConfig({ resolution: res });
            }}
          />
        );
      })}
    </fieldset>
  );
}

export function VideoDurationControl(): React.JSX.Element {
  const durationSeconds = useModelStore((s) => s.videoConfig.durationSeconds);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);

  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="text-muted-foreground text-xs">Duration</span>
      <input
        type="range"
        min={MIN_VIDEO_DURATION_SECONDS}
        max={MAX_VIDEO_DURATION_SECONDS}
        value={durationSeconds}
        onChange={(e) => {
          setVideoConfig({ durationSeconds: Number(e.target.value) });
        }}
        aria-label="Video duration in seconds"
        aria-valuetext={`${String(durationSeconds)} seconds`}
        className="accent-primary h-1 flex-1"
      />
      <span className="text-muted-foreground text-xs tabular-nums">{`${String(durationSeconds)}s`}</span>
    </div>
  );
}

export function AudioFormatControl(): React.JSX.Element {
  const format = useModelStore((s) => s.audioConfig.format);
  const setAudioConfig = useModelStore((s) => s.setAudioConfig);

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Format</legend>
      {AUDIO_FORMATS.map((f) => (
        <TogglePill
          key={f}
          label={f}
          isActive={format === f}
          onClick={() => {
            setAudioConfig({ format: f });
          }}
        />
      ))}
    </fieldset>
  );
}

export function AudioDurationControl(): React.JSX.Element {
  const maxDurationSeconds = useModelStore((s) => s.audioConfig.maxDurationSeconds);
  const setAudioConfig = useModelStore((s) => s.setAudioConfig);

  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="text-muted-foreground text-xs">Max duration</span>
      <input
        type="range"
        min={1}
        max={MAX_AUDIO_DURATION_SECONDS}
        value={maxDurationSeconds}
        onChange={(e) => {
          setAudioConfig({ maxDurationSeconds: Number(e.target.value) });
        }}
        aria-label="Audio max duration in seconds"
        aria-valuetext={`${String(maxDurationSeconds)} seconds`}
        className="accent-primary h-1 flex-1"
      />
      <span className="text-muted-foreground text-xs tabular-nums">{`${String(maxDurationSeconds)}s`}</span>
    </div>
  );
}

interface MediaCostLineProps {
  modality: 'image' | 'video' | 'audio';
}

function useImageCost(): number {
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  const pricesPerImage = selectedModels.map(
    (m) => data?.models.find((dm) => dm.id === m.id)?.pricePerImage ?? 0
  );
  return useMediaCostEstimate({
    modality: 'image',
    imagePricing: { pricesPerImage },
  }).estimatedDollars;
}

function useVideoCost(): number {
  const videoConfig = useModelStore((s) => s.videoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const pricesPerSecond = selectedModels.map(
    (m) =>
      data?.models.find((dm) => dm.id === m.id)?.pricePerSecondByResolution[
        videoConfig.resolution
      ] ?? 0
  );
  return useMediaCostEstimate({
    modality: 'video',
    videoPricing: { pricesPerSecond, durationSeconds: videoConfig.durationSeconds },
  }).estimatedDollars;
}

function useAudioCost(): number {
  const audioConfig = useModelStore((s) => s.audioConfig);
  const selectedModels = useModelStore((s) => s.selections.audio);
  const { data } = useModels();
  const pricesPerSecond = selectedModels.map(
    (m) => data?.models.find((dm) => dm.id === m.id)?.pricePerSecond ?? 0
  );
  return useMediaCostEstimate({
    modality: 'audio',
    audioPricing: { pricesPerSecond, durationSeconds: audioConfig.maxDurationSeconds },
  }).estimatedDollars;
}

function selectModalityDollars(
  modality: 'image' | 'video' | 'audio',
  imageDollars: number,
  videoDollars: number,
  audioDollars: number
): number {
  if (modality === 'image') return imageDollars;
  if (modality === 'video') return videoDollars;
  return audioDollars;
}

export function MediaCostLine({
  modality,
}: Readonly<MediaCostLineProps>): React.JSX.Element | null {
  const imageDollars = useImageCost();
  const videoDollars = useVideoCost();
  const audioDollars = useAudioCost();

  const dollars = selectModalityDollars(modality, imageDollars, videoDollars, audioDollars);
  if (dollars <= 0) return null;
  return <div className="text-muted-foreground text-xs">{`≈ $${dollars.toFixed(3)}`}</div>;
}
