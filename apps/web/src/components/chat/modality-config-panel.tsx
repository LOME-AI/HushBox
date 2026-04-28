import * as React from 'react';
import { Button, cn } from '@hushbox/ui';
import {
  IMAGE_ASPECT_RATIOS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  MIN_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_DURATION_SECONDS,
  AUDIO_FORMATS,
  MAX_AUDIO_DURATION_SECONDS,
  FEATURE_FLAGS,
} from '@hushbox/shared';
import type { Model } from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useMediaCostEstimate } from '@/hooks/use-media-cost-estimate';

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
      className="min-w-16"
    >
      {label}
    </Button>
  );
}

function CostLine({ dollars }: Readonly<{ dollars: number }>): React.JSX.Element | null {
  if (dollars <= 0) return null;
  return <div className="text-muted-foreground text-xs">≈ ${dollars.toFixed(3)}</div>;
}

function ImageConfigControls(): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.imageConfig.aspectRatio);
  const setImageConfig = useModelStore((s) => s.setImageConfig);
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  const pricesPerImage = selectedModels.map(
    (m) => data?.models.find((dm) => dm.id === m.id)?.pricePerImage ?? 0
  );
  const cost = useMediaCostEstimate({
    modality: 'image',
    imagePricing: { pricesPerImage },
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>Aspect ratio</span>
        <CostLine dollars={cost.estimatedDollars} />
      </div>
      <div className="flex flex-wrap gap-1.5">
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
      </div>
    </div>
  );
}

type SupportedResolution = (typeof VIDEO_RESOLUTIONS)[number];

/**
 * Resolutions the primary selected video model supports, in canonical order.
 * Returns an empty list when no model is selected or the selected model has no
 * per-resolution pricing; the panel then shows a hint instead of toggle buttons
 * so users don't see resolutions the backend will reject.
 */
function supportedResolutionsFor(model: Model | undefined): readonly SupportedResolution[] {
  if (!model) return [];
  const keys = Object.keys(model.pricePerSecondByResolution);
  if (keys.length === 0) return [];
  return VIDEO_RESOLUTIONS.filter((r) => keys.includes(r));
}

function VideoConfigControls(): React.JSX.Element {
  const videoConfig = useModelStore((s) => s.videoConfig);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const primaryModel = data?.models.find((m) => m.id === selectedModels[0]?.id);
  const supportedResolutions = supportedResolutionsFor(primaryModel);
  const priceByRes = primaryModel?.pricePerSecondByResolution ?? {};
  const pricesPerSecond = selectedModels.map(
    (m) =>
      data?.models.find((dm) => dm.id === m.id)?.pricePerSecondByResolution[
        videoConfig.resolution
      ] ?? 0
  );

  // If the current resolution isn't supported by the primary model, move to the first supported one.
  React.useEffect(() => {
    const first = supportedResolutions[0];
    if (first === undefined) return;
    if (!supportedResolutions.includes(videoConfig.resolution)) {
      setVideoConfig({ resolution: first });
    }
  }, [supportedResolutions, videoConfig.resolution, setVideoConfig]);

  const cost = useMediaCostEstimate({
    modality: 'video',
    videoPricing: { pricesPerSecond, durationSeconds: videoConfig.durationSeconds },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>Aspect ratio</span>
          <CostLine dollars={cost.estimatedDollars} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {VIDEO_ASPECT_RATIOS.map((ratio) => (
            <TogglePill
              key={ratio}
              label={ratio}
              isActive={videoConfig.aspectRatio === ratio}
              onClick={() => {
                setVideoConfig({ aspectRatio: ratio });
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground text-xs">Resolution</div>
        {supportedResolutions.length === 0 ? (
          <div className="text-muted-foreground text-xs italic">
            Select a video model to see resolution options.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {supportedResolutions.map((resolution) => {
              const price = priceByRes[resolution] ?? 0;
              const label = `${resolution} $${price.toFixed(2)}/s`;
              return (
                <TogglePill
                  key={resolution}
                  label={label}
                  isActive={videoConfig.resolution === resolution}
                  onClick={() => {
                    setVideoConfig({ resolution });
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>Duration</span>
          <span>{`${String(videoConfig.durationSeconds)}s`}</span>
        </div>
        <input
          type="range"
          min={MIN_VIDEO_DURATION_SECONDS}
          max={MAX_VIDEO_DURATION_SECONDS}
          value={videoConfig.durationSeconds}
          onChange={(e) => {
            setVideoConfig({ durationSeconds: Number(e.target.value) });
          }}
          aria-label="Video duration in seconds"
          className="accent-primary h-1 w-full"
        />
      </div>
    </div>
  );
}

function AudioConfigControls(): React.JSX.Element {
  const audioConfig = useModelStore((s) => s.audioConfig);
  const setAudioConfig = useModelStore((s) => s.setAudioConfig);
  const selectedModels = useModelStore((s) => s.selections.audio);
  const { data } = useModels();
  const pricesPerSecond = selectedModels.map(
    (m) => data?.models.find((dm) => dm.id === m.id)?.pricePerSecond ?? 0
  );
  const cost = useMediaCostEstimate({
    modality: 'audio',
    audioPricing: { pricesPerSecond, durationSeconds: audioConfig.maxDurationSeconds },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>Format</span>
          <CostLine dollars={cost.estimatedDollars} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {AUDIO_FORMATS.map((format) => (
            <TogglePill
              key={format}
              label={format}
              isActive={audioConfig.format === format}
              onClick={() => {
                setAudioConfig({ format });
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>Max duration</span>
          <span>{`${String(audioConfig.maxDurationSeconds)}s`}</span>
        </div>
        <input
          type="range"
          min={1}
          max={MAX_AUDIO_DURATION_SECONDS}
          value={audioConfig.maxDurationSeconds}
          onChange={(e) => {
            setAudioConfig({ maxDurationSeconds: Number(e.target.value) });
          }}
          aria-label="Audio max duration in seconds"
          className="accent-primary h-1 w-full"
        />
      </div>
    </div>
  );
}

/**
 * Renders the inline media generation config above the prompt textarea.
 * Returns null for the text modality; owns no state (reads/writes via the model store).
 * The audio panel only renders when `FEATURE_FLAGS.AUDIO_ENABLED` is true — until
 * then the prompt-input never selects the audio modality.
 */
export function ModalityConfigPanel({
  className,
}: Readonly<{ className?: string }>): React.JSX.Element | null {
  const activeModality = useModelStore((s) => s.activeModality);

  if (activeModality === 'text') return null;
  if (activeModality === 'audio' && !FEATURE_FLAGS.AUDIO_ENABLED) return null;

  return (
    <div className={cn('border-border border-b px-3 py-3', className)}>
      {activeModality === 'image' && <ImageConfigControls />}
      {activeModality === 'video' && <VideoConfigControls />}
      {activeModality === 'audio' && <AudioConfigControls />}
    </div>
  );
}
