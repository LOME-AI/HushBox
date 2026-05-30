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
import { agreedOptions, snapToNearest } from '@/lib/multi-model-agreement';
import type { Model } from '@hushbox/shared';

interface TogglePillProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  /** Tailwind width class; defaults to `w-28` for long labels (e.g., "720p $0.10/s"). */
  widthClass?: string;
}

function TogglePill({
  label,
  isActive,
  onClick,
  widthClass = 'w-28',
}: Readonly<TogglePillProps>): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      onClick={onClick}
      className={`${widthClass} whitespace-nowrap`}
    >
      {label}
    </Button>
  );
}

/**
 * Intersect each selected model's supported aspect ratios. When the intersection
 * is empty (no models selected, or no model declares the capability) fall back
 * to the canonical list so the UX stays functional for unannotated catalogs.
 * For today's ZDR set every Imagen model shares the same 5 ratios and every Veo
 * shares the same 2, so the fallback is the common path.
 */
function aspectRatiosFor(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined,
  fallback: readonly string[]
): readonly string[] {
  const intersection = agreedOptions<Model, string>(
    selectedModels,
    catalog,
    (model) => model.supportedAspectRatios
  );
  if (intersection.length === 0) return fallback;
  return fallback.filter((r) => intersection.includes(r));
}

export function ImageAspectRatioControl(): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.imageConfig.aspectRatio);
  const setImageConfig = useModelStore((s) => s.setImageConfig);
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  const supportedRatios = aspectRatiosFor(selectedModels, data?.models, IMAGE_ASPECT_RATIOS);

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Aspect ratio</legend>
      {supportedRatios.map((ratio) => (
        <TogglePill
          key={ratio}
          label={ratio}
          isActive={aspectRatio === ratio}
          widthClass="w-14"
          onClick={() => {
            setImageConfig({ aspectRatio: ratio as (typeof IMAGE_ASPECT_RATIOS)[number] });
          }}
        />
      ))}
    </fieldset>
  );
}

export function VideoAspectRatioControl(): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.videoConfig.aspectRatio);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const supportedRatios = aspectRatiosFor(selectedModels, data?.models, VIDEO_ASPECT_RATIOS);

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Aspect ratio</legend>
      {supportedRatios.map((ratio) => (
        <TogglePill
          key={ratio}
          label={ratio}
          isActive={aspectRatio === ratio}
          widthClass="w-14"
          onClick={() => {
            setVideoConfig({ aspectRatio: ratio as (typeof VIDEO_ASPECT_RATIOS)[number] });
          }}
        />
      ))}
    </fieldset>
  );
}

type SupportedResolution = (typeof VIDEO_RESOLUTIONS)[number];

/**
 * Intersect each selected model's supported resolutions, falling back to the
 * pricing-key view when a model doesn't declare `supportedVideoResolutions`
 * explicitly. Keeps multi-model dispatches honest — the backend rejects any
 * resolution that any selected model doesn't price, so the picker mirrors the
 * intersection rather than the primary's view.
 */
function videoResolutionsFor(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): readonly SupportedResolution[] {
  const intersection = agreedOptions<Model, string>(selectedModels, catalog, (model) => {
    if (model.supportedVideoResolutions !== undefined) return model.supportedVideoResolutions;
    const keys = Object.keys(model.pricePerSecondByResolution);
    if (keys.length === 0) return;
    return keys;
  });
  return VIDEO_RESOLUTIONS.filter((r) => intersection.includes(r));
}

export function VideoResolutionControl(): React.JSX.Element {
  const resolution = useModelStore((s) => s.videoConfig.resolution);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const supportedResolutions = videoResolutionsFor(selectedModels, data?.models);
  const primaryModel = data?.models.find((m) => m.id === selectedModels[0]?.id);
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

/**
 * Discrete duration set agreed across all selected video models, or
 * `undefined` when no constraint can be derived (no model selected, or none
 * declare `supportedVideoDurationsSeconds`). When undefined the slider falls
 * back to the global MIN/MAX range with no snap, preserving legacy behavior.
 */
function videoDurationsFor(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): readonly number[] | undefined {
  if (selectedModels.length === 0) return undefined;
  const intersection = agreedOptions<Model, number>(
    selectedModels,
    catalog,
    (model) => model.supportedVideoDurationsSeconds
  );
  return intersection.length === 0 ? undefined : intersection;
}

export function VideoDurationControl(): React.JSX.Element {
  const durationSeconds = useModelStore((s) => s.videoConfig.durationSeconds);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const supportedDurations = videoDurationsFor(selectedModels, data?.models);

  const min = supportedDurations?.[0] ?? MIN_VIDEO_DURATION_SECONDS;
  const max = supportedDurations?.at(-1) ?? MAX_VIDEO_DURATION_SECONDS;

  // Snap onto the supported set when one exists so the user can't ship a
  // duration value the backend would reject. Without a set, the slider runs
  // freely between MIN/MAX_VIDEO_DURATION_SECONDS as before.
  React.useEffect(() => {
    if (supportedDurations === undefined) return;
    if (supportedDurations.includes(durationSeconds)) return;
    const snapped = snapToNearest(supportedDurations, durationSeconds);
    if (snapped !== undefined && snapped !== durationSeconds) {
      setVideoConfig({ durationSeconds: snapped });
    }
  }, [supportedDurations, durationSeconds, setVideoConfig]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = Number(event.target.value);
    const value =
      supportedDurations === undefined ? raw : (snapToNearest(supportedDurations, raw) ?? raw);
    setVideoConfig({ durationSeconds: value });
  };

  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="text-muted-foreground text-xs">Duration</span>
      <input
        type="range"
        min={min}
        max={max}
        value={durationSeconds}
        onChange={handleChange}
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
