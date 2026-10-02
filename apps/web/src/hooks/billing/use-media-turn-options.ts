import * as React from 'react';
import {
  getMediaTurnOptions,
  mediaModelFromWire,
  modelId,
  nanoUSD,
  type ImageConfig,
  type MediaModel,
  type MediaSelection,
  type MediaTurnOptions,
  type PromptBasis,
  type StoredMediaModality,
  type UserTier,
  type VideoConfig,
} from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useFundingRead } from '@/hooks/billing/use-spendable';

/**
 * The `apps/web` PUBLISHER of the money layer's per-unit verdict, the sibling of
 * `use-turn-options.ts` for the token one. One publisher per produced verdict is
 * what `web-prices-through-producers` enforces — not one hook for the whole
 * module — so this file is the only one under `apps/web` that may import
 * `getMediaTurnOptions`. No surface computes a per-unit verdict of its own, so no
 * two can disagree about one.
 *
 * Its reach today is the COMPOSER: `usePromptBudget` calls it and passes the
 * verdicts down to the generation panel. The model picker is a media surface
 * that does NOT read it — it grades every modality's rows through the token
 * adapter (`use-turn-options.ts`) — so a media row's greying there is not this
 * verdict.
 *
 * It is a second hook rather than a branch inside the token adapter because the
 * two projections partition the catalog: a per-unit row carries no token rate
 * and no context length, so it has no ceiling to solve and never enters the
 * priceable pool the outlier median, the premium threshold and the classifier
 * engine are taken over.
 */

interface UseMediaTurnOptionsInput {
  readonly isAuthenticated: boolean;
  /**
   * What the turn will persist, in characters. It reaches the producer whole
   * because the producer — never a caller — decides which set is priced against
   * it: the send gate is, the greying is not.
   */
  readonly basis: PromptBasis;
  /**
   * The conversation being composed in, which is what names the PAYER: an
   * owner-funded group turn is priced from the owner's funds. Omit for a solo
   * composer or a picker opened outside a conversation.
   */
  readonly conversationId?: string | null;
}

export interface UseMediaTurnOptionsResult {
  /**
   * True while a funding or catalog input is still in flight. A surface must
   * render its neutral state while this holds — NOT a refusal, because treating
   * an absent funding read as `0n` greys every affordable row for a render.
   */
  readonly isPending: boolean;
  /**
   * True when the payer's funding read is EXHAUSTED rather than outstanding. No
   * verdict exists in that state either, but a pending read resolves itself and
   * this one never will, so rendering the same neutral state for it is an
   * indefinite silent wait.
   */
  readonly isFundingUnavailable: boolean;
  /** The produced pair, or `undefined` while there is no verdict. */
  readonly options: MediaTurnOptions | undefined;
}

/** One served funding read, as the wire carries it. */
type ServedFunding =
  | { spendableNanoUsd: string; heldNanoUsd: string; payerTier: UserTier; payer: 'self' | 'owner' }
  | undefined;

/**
 * What the user has fixed on the active modality's own config. A media turn has
 * no trial fallback: media is signed-in only, so a caller with no funding door
 * has no media turn to price either.
 */
function pinnedOf(
  modality: StoredMediaModality,
  imageConfig: ImageConfig,
  videoConfig: VideoConfig
): MediaSelection['pinned'] {
  if (modality === 'image') return { aspectRatio: imageConfig.aspectRatio };
  if (modality === 'video') {
    return {
      aspectRatio: videoConfig.aspectRatio,
      resolution: videoConfig.resolution,
      durationSeconds: String(videoConfig.durationSeconds),
    };
  }
  return {};
}

export function useMediaTurnOptions(input: UseMediaTurnOptionsInput): UseMediaTurnOptionsResult {
  const activeModality = useModelStore((state) => state.activeModality);
  const selected = useModelStore((state) => state.selections[state.activeModality]);
  const imageConfig = useModelStore((state) => state.imageConfig);
  const videoConfig = useModelStore((state) => state.videoConfig);
  const { data: modelsData } = useModels();
  const conversationId = input.conversationId ?? null;
  // ONE read: the conversation names the payer and the server has already
  // applied §Group Funding 2, so it returns the winning wallet's figures.
  const fundingRead = useFundingRead(input.isAuthenticated, conversationId);
  const served: ServedFunding = fundingRead.snapshot;

  const isFundingUnavailable = fundingRead.status === 'unavailable';
  const isPending = fundingRead.status === 'awaiting' || modelsData === undefined;

  const catalog = modelsData?.models;
  const selectedIds = selected.map((entry) => entry.id).join('\u0000');

  const { basis } = input;

  return React.useMemo((): UseMediaTurnOptionsResult => {
    // A text turn is the token producer's; there is no per-unit turn to price,
    // which is a different state from one whose inputs have not arrived.
    if (activeModality === 'text') {
      return { isPending: false, isFundingUnavailable, options: undefined };
    }
    if (isPending || catalog === undefined) {
      return { isPending: true, isFundingUnavailable, options: undefined };
    }
    // No verdict without the payer's own figures: falling back to a fabricated
    // balance would grey rows the payer can in fact afford.
    if (isFundingUnavailable || served === undefined) {
      return { isPending: false, isFundingUnavailable, options: undefined };
    }

    const rows = catalog.filter((model) => model.modality === activeModality);
    const models: MediaModel[] = [];
    for (const row of rows) {
      const projected = mediaModelFromWire(row);
      if (projected !== undefined) models.push(projected);
    }

    // Every stored id reaches the producer, including one this projection could
    // not price: a stored selection outlives the catalog it was made against —
    // the store holds no catalog and prunes nothing — and the request body
    // carries it either way. Which of them nothing prices is the producer's own
    // reading of the catalog it was handed, not a second one taken here.
    const selection: MediaSelection = {
      modality: activeModality,
      selectedIds: [...new Set(selected.map((entry) => entry.id))].map((id) => modelId(id)),
      pinned: pinnedOf(activeModality, imageConfig, videoConfig),
    };

    return {
      isPending: false,
      isFundingUnavailable: false,
      options: getMediaTurnOptions(
        {
          spendableNanoUsd: nanoUSD(BigInt(served.spendableNanoUsd)),
          heldNanoUsd: nanoUSD(BigInt(served.heldNanoUsd)),
          payerTier: served.payerTier,
          payer: served.payer,
        },
        basis,
        selection,
        models
      ),
    };
    // `selected` is a fresh array identity on every store read, so the memo keys
    // on the joined ids instead: an unchanged selection must not look changed.
  }, [
    isPending,
    isFundingUnavailable,
    catalog,
    selectedIds,
    served,
    activeModality,
    basis,
    imageConfig,
    videoConfig,
  ]);
}
