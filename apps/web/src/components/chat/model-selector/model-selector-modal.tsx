import * as React from 'react';
import { AnimatePresence } from 'framer-motion';
import { Overlay, useIsMobile } from '@hushbox/ui';
import { SMART_MODEL_ID, type Availability } from '@hushbox/shared';
import { useModelStore, type PickerMode } from '@/stores/model';
import { getAccessibleModelIds } from '@/hooks/models/models';
import { usePickerOptions } from '@/hooks/billing/use-turn-options';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';

import { SignupModal } from '@/components/auth/signup-modal';
import {
  resolveModality,
  getPinnedLabelForModel,
  toggleSortDirection,
  buildSelectedEntries,
  updateSelectedIds,
  initialFocusedId,
  type SortField,
  type SortDirection,
} from '@/components/chat/model-selector/model-selector-helpers';
import { useFilteredModels } from '@/components/chat/model-selector/use-filtered-models';
import { useModeChangeHandler } from '@/components/chat/model-selector/use-mode-change-handler';
import { useCarryoverPulse } from '@/components/chat/media/use-carryover-pulse';
import {
  ModelSelectorFooter,
  MultiCountChip,
} from '@/components/chat/model-selector/model-selector-footer';
import { ModelSelectorModalLayout } from '@/components/chat/model-selector/model-selector-layout';
import type { SearchAndSortSectionProps } from '@/components/chat/model-selector/search-and-sort-section';
import type {
  ModelSelectorGatingProps,
  RowVerdict,
} from '@/components/chat/model-selector/model-selector-types';
import type { Model, ChatModality, ModelEntry } from '@hushbox/shared';

/**
 * The verdict a PICKER row is greyed and gated by: whether clicking it yields a
 * turn that sends. A candidate row's `availability` answers a different question
 * — whether the CLASSIFIER may bind the model — and clicking is exactly what
 * changes the model's role, so forecasting the click from that field greyed
 * every non-reasoning row under any explicit effort preference, at any balance.
 * A pinned row is already in the role its verdict describes.
 *
 * WHICH activation is a restatement of the click this modal implements, which is
 * why the mapping lives here and nowhere else: a single-mode click REPLACES the
 * answer set with the row ({@link commitSingleSelection}), a multi-mode click
 * ADDS the row beside what is already selected. Reading the add arm for a
 * replacing click is what dressed every candidate in a pinned sibling's refusal.
 * Both arms are the producer's; nothing is graded here.
 */
function selectabilityOf(entry: ModelEntry, mode: PickerMode): RowVerdict {
  if (entry.kind !== 'candidate') return entry.availability;
  return mode === 'single' ? entry.activation.replace : entry.activation.add;
}

/** What a row renders as when no verdict covers it: neutral, never refused. */
const UNGRADED: Availability = { available: true };

interface ModelSelectorModalProps extends ModelSelectorGatingProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedIds: Set<string>;
  onSelect: (models: { id: string; name: string }[]) => void;
  /** Filter models to match this modality. Defaults to 'text' for back-compat. */
  activeModality?: ChatModality;
  /**
   * The conversation the picker was opened from — it NAMES THE PAYER, so
   * without it the verdict is self-funded only, which would grey models a
   * group member's delegated budget funds.
   */
  floorGroup?: { readonly conversationId: string } | undefined;
}

/**
 * Model selector modal with search, sort, premium gating, and per-modality
 * scoping. Single mode commits + closes on row click. Multi mode toggles a
 * local pending selection committed via the footer.
 */
export function ModelSelectorModal({
  open,
  onOpenChange,
  models,
  selectedIds,
  onSelect,
  premiumIds,
  isAuthenticated = true,
  isLinkGuest,
  onPremiumClick,
  activeModality,
  floorGroup,
}: Readonly<ModelSelectorModalProps>): React.JSX.Element {
  const isMobile = useIsMobile();
  // ONE verdict: the picker greys from `affordable`, the set the composer's
  // send gate is the hold-aware twin of (BILLING §Affordability, the four
  // notions). The picker asks the prompt-INDEPENDENT question — "can this payer
  // call this model at all" — so it takes the read that answers only that one.
  // It has no prompt and is handed no send gate: an admissibility computed
  // without a basis would be graded on a zero prompt, which is strictly more
  // permissive than the composer's own gate.
  // The effort the turn would actually run at. Without it every row is graded
  // at its CHEAPEST rung, which is strictly more permissive than the send — so
  // the picker would offer a model that greys the user's whole effort ladder
  // the moment it is selected.
  const { effective: effortPin } = useReasoningEffort();
  const turnOptions = usePickerOptions({
    isAuthenticated,
    ...(floorGroup === undefined ? {} : { conversationId: floorGroup.conversationId }),
    ...(effortPin === undefined ? {} : { effort: effortPin }),
  });

  const resolvedModality = resolveModality(activeModality);
  // Read before the first verdict is: every read below takes the arm this mode
  // activates, so the mode has to be in hand before any of them.
  const pickerMode = useModelStore((s) => s.pickerMode[resolvedModality]);
  const setPickerMode = useModelStore((s) => s.setPickerMode);

  /**
   * Whether this payer can reach premium models at all, READ OFF the produced
   * set rather than computed: a premium row the producer marked unavailable is
   * exactly a model this payer cannot reach. It orders the list (reachable
   * models first) and gates nothing — the verdict is already on every row.
   */
  const canAccessPremium = !(turnOptions.affordable?.all ?? []).some((row) => {
    const verdict = selectabilityOf(row, pickerMode);
    return (
      !verdict.available &&
      (verdict.reason === 'premium_requires_credit' ||
        verdict.reason === 'premium_requires_account')
    );
  });

  /**
   * A row's verdict, taken from the produced set and defaulted to nowhere. Three
   * answers, and they are different facts rather than one fallback:
   *
   * - NO VERDICT EXISTS, so the row renders NEUTRAL. While a funding or catalog
   *   read is in flight the producer has not run, and treating a pending read as
   *   a refusal is what greyed every affordable row for a render. The token
   *   producer's own refusal of a per-unit modality says the same thing about a
   *   different surface — it prices nothing image- or video-shaped, so an image
   *   or video picker holds no token verdict for any of its rows. That refusal
   *   CODE is the signal, not the empty entry list it comes with: a text set can
   *   also grade nothing, and there every row does have an answer.
   * - THE SLOT is not a catalog model, so no entry describes it and looking it up
   *   finds nothing. Its verdict arrives as its own produced value.
   * - EVERY OTHER ROW is the set's to answer, so an id it graded no entry for is
   *   an id nothing prices — refused, never available for want of an answer. That
   *   default is what left the slot ungraded on a surface that gates spending.
   */
  const availabilityOf = React.useCallback(
    (modelId: string): RowVerdict => {
      if (modelId === SMART_MODEL_ID) return turnOptions.smartSlotAvailability ?? UNGRADED;
      const affordable = turnOptions.affordable;
      if (affordable === undefined) return UNGRADED;
      if (!affordable.sendable && affordable.refusal === 'modality_not_priceable') return UNGRADED;
      const entry = affordable.all.find((row) => row.modelId === modelId);
      return entry === undefined
        ? { available: false, reason: 'model_not_priceable' }
        : selectabilityOf(entry, pickerMode);
    },
    [turnOptions.affordable, turnOptions.smartSlotAvailability, pickerMode]
  );
  /** The ordering's whole read of the verdict: greyed or not. */
  const isModelAvailable = React.useCallback(
    (modelId: string): boolean => availabilityOf(modelId).available,
    [availabilityOf]
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [focusedModelId, setFocusedModelId] = React.useState(initialFocusedId(selectedIds, models));
  const [sortField, setSortField] = React.useState<SortField>(null);
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('asc');
  const [localSelectedIds, setLocalSelectedIds] = React.useState<Set<string>>(new Set(selectedIds));
  const [expandedModelId, setExpandedModelId] = React.useState<string | null>(null);
  const [showMultiModelSignup, setShowMultiModelSignup] = React.useState(false);
  const pulsingModelId = useCarryoverPulse(pickerMode, selectedIds, open);

  React.useEffect(() => {
    if (!open) return;
    setShowMultiModelSignup(false);
    setLocalSelectedIds(new Set(selectedIds));
    setFocusedModelId(initialFocusedId(selectedIds, models));
    setSearchQuery('');
    setExpandedModelId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- models is a fallback; re-running on models change would reset user's selection
  }, [open, selectedIds]);

  // Calculate quick select model IDs based on user tier and active modality.
  // Without `activeModality`, the helper defaults to 'text' and returns text-
  // model IDs that don't match the modality-filtered list, so Strongest/Value
  // pins disappear in image/video mode.
  //
  // Candidacy is the VERDICT-AVAILABLE rows, never the whole list: a pin is a
  // recommendation to click, so crowning a refused row recommended a dead end —
  // and the row suppresses its own label, so the pin read as missing rather than
  // as refused. Filtering here also puts the verdict in the memo's deps, so the
  // pins follow a change in balance, effort or prompt instead of outliving it.
  const pinCandidates = React.useMemo(
    () => models.filter((m) => isModelAvailable(m.id)),
    [models, isModelAvailable]
  );
  const { strongestId, valueId } = React.useMemo(
    () =>
      getAccessibleModelIds(
        pinCandidates,
        premiumIds ?? new Set(),
        canAccessPremium,
        activeModality
      ),
    [pinCandidates, premiumIds, canAccessPremium, activeModality]
  );

  const { models: filteredModels, modalityIsEmpty } = useFilteredModels({
    models,
    searchQuery,
    sortField,
    sortDirection,
    isModelAvailable,
    strongestId,
    valueId,
    activeModality,
  });

  const handleSortClick = React.useCallback(
    (field: 'price' | 'context'): void => {
      if (sortField === field) {
        setSortDirection(toggleSortDirection);
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField]
  );

  const getPinnedLabel = React.useCallback(
    (modelId: string): string | undefined => getPinnedLabelForModel(modelId, strongestId, valueId),
    [strongestId, valueId]
  );

  const focusedModel = models.find((m) => m.id === focusedModelId) ?? models[0];

  const handleHoverModel = React.useCallback((modelId: string): void => {
    setFocusedModelId(modelId);
  }, []);

  const handleShowInfo = React.useCallback((modelId: string): void => {
    setFocusedModelId(modelId);
  }, []);

  const handleToggleExpand = React.useCallback((modelId: string): void => {
    setExpandedModelId((current) => (current === modelId ? null : modelId));
  }, []);

  const commitSingleSelection = React.useCallback(
    (model: Model): void => {
      onSelect([{ id: model.id, name: model.name }]);
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  const isMultiModelSignupBlocked = React.useCallback(
    (modelId: string): boolean =>
      !isLinkGuest &&
      !isAuthenticated &&
      !localSelectedIds.has(modelId) &&
      localSelectedIds.size > 0,
    [isLinkGuest, isAuthenticated, localSelectedIds]
  );

  /**
   * Mode-aware row activation. Single mode commits the picked model and closes
   * the modal; multi mode toggles the model in the local pending selection.
   * Premium gates fire before either path so unentitled users always hit the
   * paywall regardless of mode.
   */
  const handleRowActivate = React.useCallback(
    (modelId: string): void => {
      const model = models.find((m) => m.id === modelId);
      if (!model) return;

      // Removing a selection is ALWAYS allowed, checked before any refusal: a
      // model that becomes unavailable after it was selected would otherwise be
      // escapable only via Clear-all, trapping the whole selection behind the
      // one row the user wants to drop.
      const isRemoval = pickerMode === 'multi' && localSelectedIds.has(modelId);
      const verdict = availabilityOf(modelId);
      if (!isRemoval && !verdict.available) {
        // Every refusal routes to the paywall, and the REASON picks neither
        // door: signing up and adding money are the only two actions any of
        // them leaves, and which of the two applies is whether the payer has an
        // account rather than what refused the row — so the router reads the
        // session, not the code. Selecting on the reason here is what left
        // every refusal outside the premium pair a click that did nothing. The
        // reason still travels: the door is the session's to pick, but what the
        // door SAYS about this row is only true if it knows why the row refused.
        onPremiumClick?.(modelId, verdict.reason);
        return;
      }

      if (pickerMode === 'single') {
        commitSingleSelection(model);
        return;
      }

      if (isMultiModelSignupBlocked(modelId)) {
        setShowMultiModelSignup(true);
        return;
      }

      setFocusedModelId(modelId);
      setLocalSelectedIds((previous) => updateSelectedIds(previous, modelId));
    },
    [
      models,
      onPremiumClick,
      availabilityOf,
      pickerMode,
      localSelectedIds,
      isMultiModelSignupBlocked,
      commitSingleSelection,
    ]
  );

  const handleConfirmSelection = React.useCallback((): void => {
    onSelect(buildSelectedEntries(localSelectedIds, models));
    onOpenChange(false);
  }, [localSelectedIds, models, onSelect, onOpenChange]);

  const handleClearSelection = React.useCallback((): void => {
    setLocalSelectedIds(new Set());
  }, []);

  const handleCancel = React.useCallback((): void => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleModeChange = useModeChangeHandler({
    setPickerMode,
    resolvedModality,
    localSelectedIds,
    setLocalSelectedIds,
    models,
    onSelect,
  });

  // Prevent auto-focus on mobile to avoid triggering keyboard
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isMobile) {
        event.preventDefault();
      }
    },
    [isMobile]
  );

  const showFooter = pickerMode === 'multi';
  const multiSelectionCount = localSelectedIds.size;
  const multiLabel = <span>Multiple models at once</span>;

  const searchAndSortProps: SearchAndSortSectionProps = {
    searchQuery,
    onSearchChange: setSearchQuery,
    sortField,
    sortDirection,
    onSortClick: handleSortClick,
    activeModality: resolvedModality,
    rightAccessory: (
      <AnimatePresence initial={false}>
        {pickerMode === 'multi' && (
          <MultiCountChip
            key="multi-count-chip"
            selectedCount={multiSelectionCount}
            onClear={handleClearSelection}
          />
        )}
      </AnimatePresence>
    ),
  };

  return (
    <>
      <Overlay
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel="Select model"
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        <ModelSelectorModalLayout
          isMobile={isMobile}
          pickerMode={pickerMode}
          multiLabel={multiLabel}
          searchAndSortProps={searchAndSortProps}
          handleModeChange={handleModeChange}
          focusedModel={focusedModel}
          modelListBodyProps={{
            filteredModels,
            modalityIsEmpty,
            activeModality: resolvedModality,
            pickerMode,
            selectedIds,
            localSelectedIds,
            focusedModelId,
            expandedModelId,
            availabilityOf,
            isMobile,
            pulsingModelId,
            getPinnedLabel,
            onActivate: handleRowActivate,
            onHover: handleHoverModel,
            onShowInfo: handleShowInfo,
            onToggleExpand: handleToggleExpand,
          }}
          footer={
            <AnimatePresence initial={false}>
              {showFooter && (
                <ModelSelectorFooter
                  key="model-selector-footer"
                  selectedCount={multiSelectionCount}
                  onCancel={handleCancel}
                  onConfirm={handleConfirmSelection}
                />
              )}
            </AnimatePresence>
          }
        />
      </Overlay>
      <SignupModal
        variant="multi-model"
        open={showMultiModelSignup}
        onOpenChange={setShowMultiModelSignup}
      />
    </>
  );
}
