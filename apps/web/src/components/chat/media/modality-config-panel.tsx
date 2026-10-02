import * as React from 'react';
import { Button, cn } from '@hushbox/ui';
import {
  AUDIO_FORMATS,
  MAX_AUDIO_DURATION_SECONDS,
  dimensionOptionAvailability,
  nanoUnitPriceUsd,
  noticeText,
} from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { selectedServedRows, useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';
import { agreedOptions, snapToNearest } from '@/lib/chat/multi-model-agreement';
import { AspectRatioPill } from '@/components/chat/media/aspect-ratio-pill';
import { DurationSnapSlider } from '@/components/chat/media/duration-snap-slider';
import {
  aspectRatioAgreement,
  videoDurationAgreement,
  videoResolutionAgreement,
} from '@/hooks/media/use-media-axis-snap';
import type { Availability, MediaDimensionAvailability, NoticeReason } from '@hushbox/shared';
import type { AxisAgreement } from '@/lib/chat/multi-model-agreement';

/**
 * What the money layer said about this axis' options, or `undefined` while there
 * is no verdict — a funding or catalog read still in flight, or one that failed.
 * This file is the `apps/web` PUBLISHER of `dimensionOptionAvailability`, which
 * holds both halves of that verdict: an option the produced set does not grade
 * is refused, and an absent set is permissive because the SEND GATE owns that
 * state (`use-prompt-budget.ts`, the media arm) rather than this panel.
 */
interface MediaAxisProps {
  readonly dimensions?: readonly MediaDimensionAvailability[] | undefined;
  /**
   * Why the composer's send is refused, as the money layer's own typed reason
   * rather than a flag derived from it. One of them — a funding read that
   * exhausted itself — leaves this panel with nothing priced at all, and it is
   * indistinguishable from a read still in flight by the verdict above: BOTH
   * arrive here as an absent `dimensions`. The reason is what tells them apart,
   * so it travels whole and this file asks it the question (see
   * {@link isSendCheckUnavailable}). A control takes itself down in that state
   * and says nothing; the composer's notice list carries the sentence, except on
   * the sheet (see {@link MediaFundingNotice}).
   */
  readonly sendRefusal?: NoticeReason | undefined;
}

/**
 * The sentence a greyed option points at, from the one copy home the send gate
 * and the effort menu already read: a user who is told why an option is greyed
 * gets the same words whichever surface says it.
 */
function OptionRefusalReason({
  id,
  availability,
}: Readonly<{ id: string; availability: Availability }>): React.JSX.Element | null {
  if (availability.available) return null;
  return (
    <span id={id} className="sr-only">
      {noticeText(availability.reason)}
    </span>
  );
}

/**
 * A caller that lays its axes out as titled sections asks for the title here
 * rather than rendering it itself: a heading rendered by the caller stays on
 * screen when the control it labels takes itself down, announcing a section
 * with nothing in it. A caller that labels its axes by layout instead (the
 * inline desktop row) passes none, and the control renders its body bare.
 */
interface MediaAxisHeadingProps {
  readonly heading?: string | undefined;
}

function MediaAxisSection({
  heading,
  children,
}: Readonly<MediaAxisHeadingProps & { children: React.ReactNode }>): React.JSX.Element {
  if (heading === undefined) return <>{children}</>;
  return (
    <section className="flex flex-col items-center gap-2">
      <h3 className="text-muted-foreground self-start text-sm font-medium">{heading}</h3>
      {children}
    </section>
  );
}

interface TogglePillProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  /** Tailwind width class; defaults to `w-28` for long labels. */
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

interface AspectRatioGroupProps extends MediaAxisProps {
  ratios: readonly string[];
  activeRatio: string;
  onSelect: (ratio: string) => void;
  /** Pill size — `lg` for the mobile bottom sheet, `sm` for the inline desktop row. */
  pillSize?: 'sm' | 'lg';
}

/** Present when the money layer refused a ratio: the element that says why. */
type RatioRefusal = { readonly reasonId: string } | undefined;

/**
 * Each ratio as the money layer graded it, drawn by the caller beside the
 * sentence a refused one points at. Every ratio control grades through here, so
 * a greyed ratio says the same reason whichever surface shows it.
 */
export function GradedAspectRatios({
  ratios,
  dimensions,
  renderOption,
}: Readonly<{
  ratios: readonly string[];
  dimensions?: readonly MediaDimensionAvailability[] | undefined;
  renderOption: (ratio: string, refusal: RatioRefusal) => React.ReactNode;
}>): React.JSX.Element {
  const reasonIdBase = React.useId();
  return (
    <>
      {ratios.map((ratio) => {
        const availability = dimensionOptionAvailability(dimensions, 'aspectRatio', ratio);
        const reasonId = `${reasonIdBase}-${ratio}`;
        return (
          <React.Fragment key={ratio}>
            {renderOption(ratio, availability.available ? undefined : { reasonId })}
            <OptionRefusalReason id={reasonId} availability={availability} />
          </React.Fragment>
        );
      })}
    </>
  );
}

function AspectRatioGroup({
  ratios,
  activeRatio,
  onSelect,
  pillSize = 'sm',
  dimensions,
}: Readonly<AspectRatioGroupProps>): React.JSX.Element {
  return (
    <fieldset className="flex flex-wrap items-end gap-1.5 border-0 p-0">
      <legend className="sr-only">Aspect ratio</legend>
      <GradedAspectRatios
        ratios={ratios}
        dimensions={dimensions}
        renderOption={(ratio, refusal) => (
          <AspectRatioPill
            ratio={ratio}
            isActive={activeRatio === ratio}
            size={pillSize}
            {...(refusal && { unavailable: refusal })}
            onClick={() => {
              if (refusal === undefined) onSelect(ratio);
            }}
          />
        )}
      />
    </fieldset>
  );
}

/**
 * What stands where a control would, when every value that control could offer
 * is one the send would refuse. An enabled control in that state offers a choice
 * the server rejects whichever way it is answered, which is how a combination
 * that can never send used to look identical to one with no constraint at all.
 */
function ControlNotice({ children }: Readonly<{ children: string }>): React.JSX.Element {
  return (
    <p role="status" className="text-destructive text-xs">
      {children}
    </p>
  );
}

/**
 * Every selected model constrains this axis, but they share no value, so every
 * request the composer could build is refused by at least one of them.
 */
export function AxisConflictNotice({ axis }: Readonly<{ axis: string }>): React.JSX.Element {
  return (
    <ControlNotice>{`The selected models share no common ${axis}. Deselect one to continue.`}</ControlNotice>
  );
}

/**
 * The one refusal that takes a control down rather than greying options inside
 * it: no funding figure was read, so nothing on any axis has been priced and
 * every value would be refused at send. Every other refusal is a verdict ABOUT
 * the options, which the produced set already carries per option — collapsing
 * the control on one of those would hide the options that still send.
 *
 * A read still IN FLIGHT is deliberately not this state and stays permissive:
 * it resolves itself, and refusing on it would collapse the panel on every
 * conversation open. The two are told apart by the reason alone, because the
 * produced verdict is absent in both.
 *
 * This is the only comparison of that reason anywhere: every control and the
 * sheet's notice ask it here, so no surface can hold a second opinion about a
 * verdict the money layer already reached.
 */
export function isSendCheckUnavailable(
  sendRefusal: NoticeReason | undefined
): sendRefusal is 'send_check_unavailable' {
  return sendRefusal === 'send_check_unavailable';
}

/**
 * The unread funding figure, said once for a whole sheet — the composer's notice
 * list owns this sentence everywhere it can be read, and the sheet is the one
 * surface it cannot reach.
 *
 * It belongs to the sheet rather than to each control because it is ONE fact
 * about the turn, not a verdict per axis: a sheet's three axes rendering it each
 * would put the identical sentence in three live regions and a screen reader
 * would announce it three times. The axis-conflict notice repeats legitimately
 * — each of those names its own axis — and this one does not.
 *
 * Each axis still decides its own state from the same reason, and an axis with
 * a block of its own still names it: the conflict is what the user can act on,
 * so it is not displaced by the sentence beside it.
 */
export function MediaFundingNotice({
  sendRefusal,
}: Readonly<Pick<MediaAxisProps, 'sendRefusal'>> = {}): React.JSX.Element | null {
  if (!isSendCheckUnavailable(sendRefusal)) return null;
  return <ControlNotice>{noticeText(sendRefusal)}</ControlNotice>;
}

interface AspectRatioControlProps extends MediaAxisProps, MediaAxisHeadingProps {
  /** Pill size — `lg` for the mobile bottom sheet, `sm` for the inline row. */
  pillSize?: 'sm' | 'lg';
}

/** The image turn's ratio, the setter for it, and what the selected image models agree on. */
export function useImageAspectRatio(): {
  readonly aspectRatio: string;
  readonly choose: (ratio: string) => void;
  readonly agreement: AxisAgreement<string>;
} {
  const aspectRatio = useModelStore((s) => s.imageConfig.aspectRatio);
  const setImageConfig = useModelStore((s) => s.setImageConfig);
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  return {
    aspectRatio,
    choose: (ratio) => {
      setImageConfig({ aspectRatio: ratio });
    },
    agreement: aspectRatioAgreement(selectedModels, data?.models),
  };
}

export function ImageAspectRatioControl({
  pillSize = 'sm',
  heading,
  dimensions,
  sendRefusal,
}: Readonly<AspectRatioControlProps> = {}): React.JSX.Element | null {
  const { aspectRatio, choose, agreement } = useImageAspectRatio();

  // The conflict is named FIRST wherever both hold: it is a property of the
  // selection that no retry clears, while the unread funding resolves on its
  // own — leading with the self-clearing one would park a permanent problem
  // behind a temporary sentence.
  if (agreement.kind === 'conflict')
    return (
      <MediaAxisSection heading={heading}>
        <AxisConflictNotice axis="aspect ratio" />
      </MediaAxisSection>
    );
  if (isSendCheckUnavailable(sendRefusal)) return null;

  return (
    <MediaAxisSection heading={heading}>
      <AspectRatioGroup
        ratios={agreedOptions(agreement)}
        activeRatio={aspectRatio}
        pillSize={pillSize}
        {...(dimensions === undefined ? {} : { dimensions })}
        onSelect={choose}
      />
    </MediaAxisSection>
  );
}

export function VideoAspectRatioControl({
  pillSize = 'sm',
  heading,
  dimensions,
  sendRefusal,
}: Readonly<AspectRatioControlProps> = {}): React.JSX.Element | null {
  const aspectRatio = useModelStore((s) => s.videoConfig.aspectRatio);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const agreement = aspectRatioAgreement(selectedModels, data?.models);
  const supportedRatios = agreedOptions(agreement);

  if (agreement.kind === 'conflict')
    return (
      <MediaAxisSection heading={heading}>
        <AxisConflictNotice axis="aspect ratio" />
      </MediaAxisSection>
    );
  if (isSendCheckUnavailable(sendRefusal)) return null;

  return (
    <MediaAxisSection heading={heading}>
      <AspectRatioGroup
        ratios={supportedRatios}
        activeRatio={aspectRatio}
        pillSize={pillSize}
        {...(dimensions === undefined ? {} : { dimensions })}
        onSelect={(ratio) => {
          setVideoConfig({ aspectRatio: ratio });
        }}
      />
    </MediaAxisSection>
  );
}

/**
 * Consumer-friendly label paired with the raw resolution — a presentation map
 * over tier names the catalog mints, never a domain: a tier with no entry here
 * still renders, under its own name.
 */
const RESOLUTION_LABELS: Record<string, { readonly primary: string; readonly secondary: string }> =
  {
    '720p': { primary: 'HD', secondary: '720p' },
    '1080p': { primary: 'FHD', secondary: '1080p' },
    '4k': { primary: '4K', secondary: '2160p' },
  };

interface ResolutionPillProps {
  res: string;
  isActive: boolean;
  onClick: () => void;
  /** Present when the money layer refused this option; see {@link AspectRatioPill}. */
  unavailable?: { readonly reasonId: string };
}

function ResolutionPill({
  res,
  isActive,
  onClick,
  unavailable,
}: Readonly<ResolutionPillProps>): React.JSX.Element {
  const labels = RESOLUTION_LABELS[res] ?? { primary: res, secondary: '' };
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      aria-label={res}
      onClick={onClick}
      {...(unavailable && { 'aria-disabled': true, 'aria-describedby': unavailable.reasonId })}
      className={cn(
        'flex h-14 w-16 flex-col items-center justify-center gap-0.5 p-0',
        unavailable && 'cursor-not-allowed opacity-60'
      )}
    >
      <span className="text-sm leading-none font-semibold">{labels.primary}</span>
      {labels.secondary ? (
        <span className="text-xs leading-none opacity-75">{labels.secondary}</span>
      ) : null}
    </Button>
  );
}

export function VideoResolutionControl({
  heading,
  dimensions,
  sendRefusal,
}: Readonly<MediaAxisProps & MediaAxisHeadingProps> = {}): React.JSX.Element | null {
  const resolution = useModelStore((s) => s.videoConfig.resolution);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const agreement = videoResolutionAgreement(selectedModels, data?.models);
  const supportedResolutions = agreedOptions(agreement);
  const reasonIdBase = React.useId();

  if (agreement.kind === 'conflict')
    return (
      <MediaAxisSection heading={heading}>
        <AxisConflictNotice axis="resolution" />
      </MediaAxisSection>
    );

  if (supportedResolutions.length === 0) {
    return (
      <MediaAxisSection heading={heading}>
        <div className="text-muted-foreground text-xs italic">
          Select a video model to see resolution options.
        </div>
      </MediaAxisSection>
    );
  }
  if (isSendCheckUnavailable(sendRefusal)) return null;

  return (
    <MediaAxisSection heading={heading}>
      <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
        <legend className="sr-only">Resolution</legend>
        {supportedResolutions.map((res) => {
          const availability = dimensionOptionAvailability(dimensions, 'resolution', res);
          const reasonId = `${reasonIdBase}-${res}`;
          return (
            <React.Fragment key={res}>
              <ResolutionPill
                res={res}
                isActive={resolution === res}
                {...(availability.available ? {} : { unavailable: { reasonId } })}
                onClick={() => {
                  if (!availability.available) return;
                  setVideoConfig({ resolution: res });
                }}
              />
              <OptionRefusalReason id={reasonId} availability={availability} />
            </React.Fragment>
          );
        })}
      </fieldset>
    </MediaAxisSection>
  );
}

/**
 * The slider's travel when the selected models declare NO duration domain. A
 * catalog row with no `durationSeconds` spec is unconstrained on that axis, so
 * there is nothing to derive a range from and nothing validates against these:
 * they size a control, and the model's own ParamSpecs remain the only authority
 * on which duration is acceptable.
 */
const UNCONSTRAINED_DURATION_MIN_SECONDS = 1;
const UNCONSTRAINED_DURATION_MAX_SECONDS = 8;

/** One offered duration, its verdict, and the element that carries the reason. */
interface GradedDuration {
  readonly seconds: number;
  readonly reasonId: string;
  readonly availability: Availability;
}

/**
 * The verdict on each duration this control OFFERS, asked under the duration
 * axis' own id and keyed by the option id the money layer mints (the second
 * count itself).
 *
 * Only the discrete offered set is graded. An unconstrained axis offers no
 * option — no selected model declares a duration domain — so there is nothing
 * for the producer to have graded and nothing to ask it about; the slider runs
 * its presentation range there, which is the state the send gate does not
 * refuse either.
 */
function gradedDurations(
  supportedDurations: readonly number[] | undefined,
  dimensions: readonly MediaDimensionAvailability[] | undefined,
  reasonIdBase: string
): readonly GradedDuration[] {
  return (supportedDurations ?? []).map((seconds) => ({
    seconds,
    reasonId: `${reasonIdBase}-${String(seconds)}`,
    availability: dimensionOptionAvailability(dimensions, 'durationSeconds', String(seconds)),
  }));
}

/** The reason element per refused duration — the slider's greying, from one derivation. */
function unavailableDurationPoints(graded: readonly GradedDuration[]): Record<number, string> {
  return Object.fromEntries(
    graded
      .filter((duration) => !duration.availability.available)
      .map((duration) => [duration.seconds, duration.reasonId])
  );
}

/**
 * Keep a DRAGGED duration on the supported set — the slider reports a continuous
 * value and only the offered ones are sendable. Holding the STORED value there
 * is the app-wide snap's job, not a control's: this one only exists while the
 * slider is on screen.
 *
 * A refused duration is dropped here rather than in the slider, so a drag and a
 * tick click are refused by the SAME reading of the verdict — a control that
 * greyed the tick but honoured the drag onto it would offer at one gesture what
 * it refuses at another.
 */
function durationDragHandler(
  supportedDurations: readonly number[] | undefined,
  unavailablePoints: Readonly<Record<number, string>>,
  setVideoConfig: (config: { durationSeconds: number }) => void
): (raw: number) => void {
  return (raw: number): void => {
    const value =
      supportedDurations === undefined
        ? raw
        : /* v8 ignore start -- supportedDurations is a non-empty set here (an `agreed` axis is never empty), so snapToNearest never returns undefined */
          (snapToNearest(supportedDurations, raw) ?? raw);
    /* v8 ignore stop */
    if (unavailablePoints[value] !== undefined) return;
    setVideoConfig({ durationSeconds: value });
  };
}

/** The slider's travel: an agreed set's own ends, else the presentation range. */
function durationBounds(supported: readonly number[] | undefined): {
  readonly min: number;
  readonly max: number;
} {
  return {
    min: supported?.[0] ?? UNCONSTRAINED_DURATION_MIN_SECONDS,
    max: supported?.at(-1) ?? UNCONSTRAINED_DURATION_MAX_SECONDS,
  };
}

export function VideoDurationControl({
  heading,
  dimensions,
  sendRefusal,
}: Readonly<MediaAxisProps & MediaAxisHeadingProps> = {}): React.JSX.Element | null {
  const durationSeconds = useModelStore((s) => s.videoConfig.durationSeconds);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const reasonIdBase = React.useId();
  const agreement = videoDurationAgreement(selectedModels, data?.models);
  const supportedDurations = agreement.kind === 'agreed' ? agreement.options : undefined;

  const { min, max } = durationBounds(supportedDurations);
  const graded = gradedDurations(supportedDurations, dimensions, reasonIdBase);
  const unavailablePoints = unavailableDurationPoints(graded);
  const handleChange = durationDragHandler(supportedDurations, unavailablePoints, setVideoConfig);

  if (agreement.kind === 'conflict')
    return (
      <MediaAxisSection heading={heading}>
        <AxisConflictNotice axis="duration" />
      </MediaAxisSection>
    );
  if (isSendCheckUnavailable(sendRefusal)) return null;

  return (
    <MediaAxisSection heading={heading}>
      {/* The heading already says the axis, so the inline label would say it
          twice; max-w-xs keeps the slider off the full width of the sheet that
          is the only surface heading it. */}
      <div
        className={cn(
          'flex w-full min-w-0 items-center gap-2',
          heading !== undefined && 'max-w-xs'
        )}
      >
        {heading === undefined ? (
          <span className="text-muted-foreground shrink-0 text-xs">Duration</span>
        ) : null}
        <DurationSnapSlider
          value={durationSeconds}
          min={min}
          max={max}
          {...(supportedDurations !== undefined && { snapPoints: supportedDurations })}
          unavailablePoints={unavailablePoints}
          ariaLabel="Video duration in seconds"
          onChange={handleChange}
        />
        {graded.map((duration) => (
          <OptionRefusalReason
            key={duration.seconds}
            id={duration.reasonId}
            availability={duration.availability}
          />
        ))}
        <span className="text-muted-foreground min-w-[3.5ch] shrink-0 text-right text-xs tabular-nums">{`${String(durationSeconds)}s`}</span>
      </div>
    </MediaAxisSection>
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

/** Decimals the estimate shows — the same precision as the per-image rate beside it. */
const MEDIA_ESTIMATE_DECIMALS = 3;

// Every row below comes from the ONE selection projection the composer's
// funding estimate prices through. This surface used to build its own rates
// with `?? '0'`, which priced a model the catalog carries no rate for as free.
function useImageCost(): bigint | undefined {
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  return useMediaCostEstimate({
    modality: 'image',
    models: selectedServedRows(selectedModels, data?.models),
    videoResolution: '',
    durationSeconds: 0,
  });
}

function useVideoCost(): bigint | undefined {
  const videoConfig = useModelStore((s) => s.videoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  return useMediaCostEstimate({
    modality: 'video',
    models: selectedServedRows(selectedModels, data?.models),
    videoResolution: videoConfig.resolution,
    durationSeconds: videoConfig.durationSeconds,
  });
}

function useAudioCost(): bigint | undefined {
  const audioConfig = useModelStore((s) => s.audioConfig);
  const selectedModels = useModelStore((s) => s.selections.audio);
  // Asked like the other two although no price kind represents audio, so the
  // producer refuses every audio turn: when one does, this surface reads it from
  // the same producer as the funding estimate rather than from a copy of its own.
  const { data } = useModels();
  return useMediaCostEstimate({
    modality: 'audio',
    models: selectedServedRows(selectedModels, data?.models),
    videoResolution: '',
    durationSeconds: audioConfig.maxDurationSeconds,
  });
}

function selectModalityEstimate(
  modality: 'image' | 'video' | 'audio',
  imageNanoUsd: bigint | undefined,
  videoNanoUsd: bigint | undefined,
  audioNanoUsd: bigint | undefined
): bigint | undefined {
  if (modality === 'image') return imageNanoUsd;
  if (modality === 'video') return videoNanoUsd;
  return audioNanoUsd;
}

export function MediaCostLine({
  modality,
}: Readonly<MediaCostLineProps>): React.JSX.Element | null {
  const imageNanoUsd = useImageCost();
  const videoNanoUsd = useVideoCost();
  const audioNanoUsd = useAudioCost();

  const estimateNanoUsd = selectModalityEstimate(
    modality,
    imageNanoUsd,
    videoNanoUsd,
    audioNanoUsd
  );
  // No price is not a price of zero: an unpriceable turn (a rate the catalog
  // does not carry) shows nothing rather than "≈ $0.000".
  if (estimateNanoUsd === undefined || estimateNanoUsd <= 0n) return null;
  return (
    <div className="flex flex-col items-end leading-tight whitespace-nowrap">
      <span className="text-foreground font-mono text-xs">{`≈ ${nanoUnitPriceUsd(estimateNanoUsd, MEDIA_ESTIMATE_DECIMALS)}`}</span>
      <span className="text-caption text-muted-foreground font-sans">(estimate)</span>
    </div>
  );
}
