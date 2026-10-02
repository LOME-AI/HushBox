import * as React from 'react';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { priceDisplayOf } from '@/lib/chat/model-info-facts';
import { agreedAxis, agreedOptions, snapToNearest } from '@/lib/chat/multi-model-agreement';
import type { AxisAgreement } from '@/lib/chat/multi-model-agreement';
import type { Model } from '@hushbox/shared';

/**
 * Agreement on aspect ratio across the selected models. There is no global
 * fallback list: a media row that declares no aspect-ratio domain never reaches
 * the catalog (ingestion excludes it).
 */
export function aspectRatioAgreement(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): AxisAgreement<string> {
  return agreedAxis<Model, string>(selectedModels, catalog, (model) => model.supportedAspectRatios);
}

/**
 * Intersect each selected model's supported resolutions, falling back to the
 * resolutions its displayed price covers when a model doesn't declare
 * `supportedVideoResolutions` explicitly. Keeps multi-model dispatches honest — the backend rejects any
 * resolution that any selected model doesn't price, so the picker mirrors the
 * intersection rather than the primary's view. The order is the first selected
 * model's declared order; there is no global tier list to impose one.
 */
export function videoResolutionAgreement(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): AxisAgreement<string> {
  return agreedAxis<Model, string>(selectedModels, catalog, (model) => {
    if (model.supportedVideoResolutions !== undefined) return model.supportedVideoResolutions;
    const keys = Object.keys(priceDisplayOf(model).perSecondNanoUsd ?? {});
    if (keys.length === 0) return;
    return keys;
  });
}

/**
 * Duration agreement across the selected video models. An `unconstrained` axis
 * lets the slider run the presentation range with no snap and is deliberately
 * not refused, matching the server; a `conflict` is the state that used to be
 * indistinguishable from it, and it is the one no request can satisfy — the
 * composer's send gate refuses it with `option_not_offered` (see
 * {@link useMediaAxisSnap}).
 */
export function videoDurationAgreement(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): AxisAgreement<number> {
  const agreement = agreedAxis<Model, number>(
    selectedModels,
    catalog,
    (model) => model.supportedVideoDurationsSeconds
  );
  if (agreement.kind !== 'agreed') return agreement;
  // Catalog duration sets carry no order guarantee; the slider takes min/max
  // positionally (first/last), so an unsorted set would render an inverted
  // range. Sort ascending here — the single derivation point — not per consumer.
  return { kind: 'agreed', options: agreement.options.toSorted((a, b) => a - b) };
}

/**
 * Pull a stored option that the offered set no longer contains back onto that
 * set — first offered, because a ratio or resolution ladder carries no ordering
 * to snap a "nearest" along. Without it a stored value survives a model switch,
 * renders no active control, and refuses the send with `option_not_offered`
 * over a choice the user never made.
 */
function useFirstOfferedSnap(
  offered: readonly string[],
  active: string,
  apply: (option: string) => void
): void {
  React.useEffect(() => {
    const first = offered[0];
    if (first === undefined) return;
    if (offered.includes(active)) return;
    apply(first);
  }, [offered, active, apply]);
}

/**
 * Hold the stored duration on the supported set whenever one exists, so the user
 * can't ship a value the backend would reject. Without a set the axis is
 * unconstrained and any value is legal.
 */
function useNearestSnap(
  supported: readonly number[] | undefined,
  active: number,
  apply: (value: number) => void
): void {
  React.useEffect(() => {
    if (supported === undefined) return;
    if (supported.includes(active)) return;
    const snapped = snapToNearest(supported, active);
    if (snapped !== undefined && snapped !== active) apply(snapped);
  }, [supported, active, apply]);
}

/**
 * Hold every media axis' stored option on what the selected models jointly
 * offer — aspect ratio (image and video), resolution and duration.
 *
 * It lives OFF the controls deliberately. Each axis used to snap inside its own
 * control's effect, so the correction ran only while that control was mounted:
 * on mobile the controls mount only while the generation sheet is open, so a
 * user who never opened it kept a stored option no selected model offers, and
 * before the send gate refused that turn it reached the server as a 400.
 * Mounting this once, app-wide, fixes the class rather than one axis. It reads
 * the store the controls read, so nothing here can disagree with what they
 * render.
 *
 * A conflicting axis (the selected models share no value) is deliberately left
 * alone: there is no member of an empty intersection to snap onto, so the panel
 * shows the axis' conflict notice in place of the control.
 *
 * The composer's send gate refuses that turn — the money layer prices the pin
 * the request will actually carry, so a pinned option a selected model does not
 * offer refuses with `option_not_offered` on all three axes rather than pricing
 * that model's cheapest instead. Snapping is therefore the affordance, never the
 * guard: it moves a stored option onto the intersection while one exists, and
 * the refusal is what covers the empty one. Deriving "conflict" a second time
 * here would be a second verdict producer disagreeing with the first.
 */
export function useMediaAxisSnap(): void {
  const imageSelections = useModelStore((state) => state.selections.image);
  const videoSelections = useModelStore((state) => state.selections.video);
  const imageAspectRatio = useModelStore((state) => state.imageConfig.aspectRatio);
  const videoConfig = useModelStore((state) => state.videoConfig);
  const setImageConfig = useModelStore((state) => state.setImageConfig);
  const setVideoConfig = useModelStore((state) => state.setVideoConfig);
  const { data } = useModels();
  const catalog = data?.models;

  const imageRatios = agreedOptions(aspectRatioAgreement(imageSelections, catalog));
  const videoRatios = agreedOptions(aspectRatioAgreement(videoSelections, catalog));
  const videoResolutions = agreedOptions(videoResolutionAgreement(videoSelections, catalog));
  const durationAgreement = videoDurationAgreement(videoSelections, catalog);
  const durations = durationAgreement.kind === 'agreed' ? durationAgreement.options : undefined;

  const applyImageRatio = React.useCallback(
    (aspectRatio: string) => {
      setImageConfig({ aspectRatio });
    },
    [setImageConfig]
  );
  const applyVideoRatio = React.useCallback(
    (aspectRatio: string) => {
      setVideoConfig({ aspectRatio });
    },
    [setVideoConfig]
  );
  const applyResolution = React.useCallback(
    (resolution: string) => {
      setVideoConfig({ resolution });
    },
    [setVideoConfig]
  );
  const applyDuration = React.useCallback(
    (durationSeconds: number) => {
      setVideoConfig({ durationSeconds });
    },
    [setVideoConfig]
  );

  useFirstOfferedSnap(imageRatios, imageAspectRatio, applyImageRatio);
  useFirstOfferedSnap(videoRatios, videoConfig.aspectRatio, applyVideoRatio);
  useFirstOfferedSnap(videoResolutions, videoConfig.resolution, applyResolution);
  useNearestSnap(durations, videoConfig.durationSeconds, applyDuration);
}
