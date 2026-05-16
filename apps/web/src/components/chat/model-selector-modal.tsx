import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Link } from '@tanstack/react-router';
import { Search, ChevronUp, ChevronDown, Lock, Square, CheckSquare, Info } from 'lucide-react';
import {
  Overlay,
  Input,
  Button,
  ModalActions,
  ScrollArea,
  cn,
  useIsMobile,
  useIsTouchDevice,
} from '@hushbox/ui';
import { ROUTES, MAX_SELECTED_MODELS, shortenModelName } from '@hushbox/shared';
import { useModelStore, type PickerMode } from '@/stores/model';
import { formatContextLength } from '../../lib/format';
import { getAccessibleModelIds } from '../../hooks/models';

import { ModelInfoPanel } from './model-info-panel';
import { PickerModeToggle } from './picker-mode-toggle';
import { SignupModal } from '../auth/signup-modal';
import type { ModelSelectorGatingProps } from './model-selector-types';
import type { Model, Modality } from '@hushbox/shared';

type SortField = 'price' | 'context' | null;
type SortDirection = 'asc' | 'desc';

function filterBySearch(models: Model[], query: string): Model[] {
  if (!query.trim()) {
    return models;
  }
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(lowerQuery) ||
      model.provider.toLowerCase().includes(lowerQuery)
  );
}

function resolveModality(activeModality: Modality | undefined): Modality {
  return activeModality ?? 'text';
}

function priceSortKey(model: Model, modality: Modality): number {
  switch (modality) {
    case 'text': {
      return model.pricePerInputToken;
    }
    case 'image': {
      return model.pricePerImage;
    }
    case 'video': {
      const values = Object.values(model.pricePerSecondByResolution);
      return values.length > 0 ? Math.min(...values) : 0;
    }
    case 'audio': {
      return model.pricePerSecond;
    }
  }
}

function sortModels(
  models: Model[],
  sortField: SortField,
  sortDirection: SortDirection,
  activeModality: Modality
): Model[] {
  if (!sortField) {
    return models;
  }
  return [...models].toSorted((a, b) => {
    let comparison = 0;
    if (sortField === 'price') {
      comparison = priceSortKey(a, activeModality) - priceSortKey(b, activeModality);
    } else {
      comparison = a.contextLength - b.contextLength;
    }
    return sortDirection === 'asc' ? comparison : -comparison;
  });
}

function interlaceModels(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean
): Model[] {
  if (canAccessPremium || premiumIds.size === 0) {
    return models;
  }
  const basic = models.filter((m) => !premiumIds.has(m.id));
  const premium = models.filter((m) => premiumIds.has(m.id));
  const interlaced: Model[] = [];
  const maxLength = Math.max(basic.length, premium.length);
  for (let index = 0; index < maxLength; index++) {
    const basicModel = basic[index];
    const premiumModel = premium[index];
    if (basicModel) interlaced.push(basicModel);
    if (premiumModel) interlaced.push(premiumModel);
  }
  return interlaced;
}

interface SortButtonProps {
  field: 'price' | 'context';
  label: string;
  activeField: SortField;
  direction: SortDirection;
  onClick: (field: 'price' | 'context') => void;
}

function SortButton({
  field,
  label,
  activeField,
  direction,
  onClick,
}: Readonly<SortButtonProps>): React.JSX.Element {
  const isActive = activeField === field;
  return (
    <Button
      variant={isActive ? 'default' : 'outline'}
      size="sm"
      onClick={() => {
        onClick(field);
      }}
      className="w-full gap-1"
      data-active={isActive}
      data-direction={isActive ? direction : undefined}
    >
      {label}
      {isActive &&
        (direction === 'asc' ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        ))}
    </Button>
  );
}

interface ModelItemOverlayProps {
  isAuthenticated: boolean;
}

function ModelItemOverlay({ isAuthenticated }: Readonly<ModelItemOverlayProps>): React.JSX.Element {
  if (isAuthenticated) {
    return (
      <span className="shrink-0 text-xs">
        <Link
          to={ROUTES.BILLING}
          className="text-primary hover:underline"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          Top up
        </Link>
        <span className="text-muted-foreground"> to unlock</span>
      </span>
    );
  }
  return (
    <span className="shrink-0 text-xs">
      <Link
        to={ROUTES.SIGNUP}
        className="text-primary hover:underline"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        Sign up
      </Link>
      <span className="text-muted-foreground"> to access</span>
    </span>
  );
}

interface ModelItemDetailsProps {
  model: Model;
  showOverlay: boolean;
  isAuthenticated: boolean;
  pinnedLabel?: string | undefined;
}

function modelSubtitle(model: Model): string {
  if (model.isSmartModel === true) {
    return 'Auto-picks the best model';
  }
  switch (model.modality) {
    case 'text': {
      return `${model.provider} • Capacity: ${formatContextLength(model.contextLength)}`;
    }
    case 'image': {
      return `${model.provider} • $${model.pricePerImage.toFixed(3)}/image`;
    }
    case 'video': {
      const values = Object.values(model.pricePerSecondByResolution);
      if (values.length === 0) {
        return model.provider;
      }
      return `${model.provider} • $${Math.min(...values).toFixed(2)}/s`;
    }
    case 'audio': {
      return `${model.provider} • $${model.pricePerSecond.toFixed(3)}/s`;
    }
  }
}

function ModelItemDetails({
  model,
  showOverlay,
  isAuthenticated,
  pinnedLabel,
}: Readonly<ModelItemDetailsProps>): React.JSX.Element {
  // Per-model "Web Search" badges intentionally omitted — search is universal
  // across text models now (per gateway plan §9.2); per-model badges are noise.
  return (
    <div className="text-muted-foreground relative flex items-center justify-between text-xs">
      <span className="truncate">{modelSubtitle(model)}</span>
      {showOverlay && <ModelItemOverlay isAuthenticated={isAuthenticated} />}
      {!showOverlay && pinnedLabel && (
        <span className="text-muted-foreground shrink-0 text-xs">{pinnedLabel}</span>
      )}
    </div>
  );
}

interface ModelItemContentProps {
  model: Model;
  showOverlay: boolean;
  isAuthenticated: boolean;
  pinnedLabel?: string | undefined;
}

function ModelItemContent({
  model,
  showOverlay,
  isAuthenticated,
  pinnedLabel,
}: Readonly<ModelItemContentProps>): React.JSX.Element {
  return (
    <div className="w-0 min-w-0 flex-1 p-3">
      <div className="relative flex items-center justify-between gap-2">
        <span className="truncate font-medium">{shortenModelName(model.name)}</span>
        {showOverlay && (
          <Lock data-testid="lock-icon" className="text-muted-foreground h-4 w-4 shrink-0" />
        )}
      </div>
      <ModelItemDetails
        model={model}
        showOverlay={showOverlay}
        isAuthenticated={isAuthenticated}
        pinnedLabel={pinnedLabel}
      />
    </div>
  );
}

interface ModelListItemProps {
  model: Model;
  isFocused: boolean;
  isSelected: boolean;
  isDisabled: boolean;
  isPremium: boolean;
  canAccessPremium: boolean;
  isAuthenticated: boolean;
  isLinkGuest: boolean;
  pickerMode: PickerMode;
  pinnedLabel?: string | undefined;
  isExpanded: boolean;
  isMobile: boolean;
  /**
   * Highlights the row briefly via a one-shot pulse animation. Used to draw
   * attention to the carryover-selected model when entering multi mode.
   */
  isPulsing: boolean;
  /** Row position used by the checkbox cascade-in/out animation. */
  cascadeIndex: number;
  onActivate: () => void;
  onHover: () => void;
  onShowInfo: () => void;
  onToggleExpand: () => void;
}

const CHECKBOX_CASCADE_STAGGER_MS = 40;

/**
 * Each row contributes its own stagger delay based on its cascade index.
 * Enter (single → multi) and exit (multi → single) both cascade top-to-bottom.
 * Width animates from 0 → auto so the model name text slides over smoothly
 * instead of jumping when the checkbox appears.
 */
function ModelCheckboxIcon({
  isSelected,
  cascadeIndex,
}: Readonly<{ isSelected: boolean; cascadeIndex: number }>): React.JSX.Element {
  const reduceMotion = useReducedMotion() ?? false;
  const delay = reduceMotion ? 0 : (cascadeIndex * CHECKBOX_CASCADE_STAGGER_MS) / 1000;
  return (
    <motion.span
      data-testid="model-checkbox"
      data-cascade-index={cascadeIndex}
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      aria-hidden
      initial={reduceMotion ? false : { opacity: 0, scale: 0.5, width: 0, marginLeft: 0 }}
      animate={{ opacity: 1, scale: 1, width: 24, marginLeft: 8 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, width: 0, marginLeft: 0 }}
      transition={
        reduceMotion ? { duration: 0 } : { delay, duration: 0.18, ease: [0.34, 1.56, 0.64, 1] }
      }
    >
      {isSelected ? (
        <CheckSquare className="text-primary h-4 w-4" />
      ) : (
        <Square className="text-muted-foreground h-4 w-4" />
      )}
    </motion.span>
  );
}

interface RowMainButtonProps {
  model: Model;
  pickerMode: PickerMode;
  isSelected: boolean;
  isFocused: boolean;
  isDisabled: boolean;
  showOverlay: boolean;
  isAuthenticated: boolean;
  pinnedLabel?: string | undefined;
  /** Row position used by the checkbox cascade-in/out animation. */
  cascadeIndex: number;
  onActivate: () => void;
  onHover: () => void;
}

function RowMainButton({
  model,
  pickerMode,
  isSelected,
  isFocused,
  isDisabled,
  showOverlay,
  isAuthenticated,
  pinnedLabel,
  cascadeIndex,
  onActivate,
  onHover,
}: Readonly<RowMainButtonProps>): React.JSX.Element {
  const ariaLabel =
    pickerMode === 'single' ? `Use ${model.name}` : `Toggle selection for ${model.name}`;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cn(
        'flex flex-1 cursor-pointer items-center rounded-md text-left transition-colors',
        !isSelected && !isFocused && !isDisabled && 'hover:bg-muted'
      )}
      onClick={onActivate}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <AnimatePresence initial={false}>
        {pickerMode === 'multi' && (
          <ModelCheckboxIcon key="checkbox" isSelected={isSelected} cascadeIndex={cascadeIndex} />
        )}
      </AnimatePresence>
      <ModelItemContent
        model={model}
        showOverlay={showOverlay}
        isAuthenticated={isAuthenticated}
        pinnedLabel={pinnedLabel}
      />
    </button>
  );
}

interface RowInfoIconButtonProps {
  modelName: string;
  onShowInfo: () => void;
}

function RowInfoIconButton({
  modelName,
  onShowInfo,
}: Readonly<RowInfoIconButtonProps>): React.JSX.Element | null {
  // Solution B: only show on touch-primary devices (no hover capability).
  // Using the JS hook (not a CSS media query) so the dev `Touch Mode` toggle
  // in the sidebar actually exercises this code path on a desktop browser.
  const isTouchDevice = useIsTouchDevice();
  if (!isTouchDevice) return null;
  return (
    <button
      data-testid="row-info-icon"
      type="button"
      aria-label={`Show details for ${modelName}`}
      className="text-muted-foreground hover:bg-muted/50 hover:text-foreground relative flex w-12 shrink-0 cursor-pointer items-center justify-center self-stretch rounded transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        onShowInfo();
      }}
    >
      <Info className="h-5 w-5" />
    </button>
  );
}

interface RowChevronButtonProps {
  modelName: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

function RowChevronButton({
  modelName,
  isExpanded,
  onToggleExpand,
}: Readonly<RowChevronButtonProps>): React.JSX.Element {
  const ChevronIcon = isExpanded ? ChevronUp : ChevronDown;
  const ariaLabel = isExpanded
    ? `Collapse details for ${modelName}`
    : `Show details for ${modelName}`;
  return (
    <button
      data-testid="row-expand-chevron"
      type="button"
      aria-label={ariaLabel}
      aria-expanded={isExpanded}
      className="text-muted-foreground hover:bg-muted/50 hover:text-foreground relative flex w-12 shrink-0 cursor-pointer items-center justify-center self-stretch rounded transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        onToggleExpand();
      }}
    >
      <ChevronIcon className="h-5 w-5" />
    </button>
  );
}

function expandedRowButtonLabel(
  pickerMode: PickerMode,
  isSelected: boolean,
  modelName: string
): string {
  if (pickerMode === 'single') return `Use ${shortenModelName(modelName)}`;
  if (isSelected) return 'Remove from selection';
  return 'Add to selection';
}

interface RowExpandedInfoProps {
  model: Model;
  pickerMode: PickerMode;
  isSelected: boolean;
  onActivate: () => void;
}

function RowExpandedInfo({
  model,
  pickerMode,
  isSelected,
  onActivate,
}: Readonly<RowExpandedInfoProps>): React.JSX.Element {
  return (
    <div data-testid="row-expanded-info" className="border-border-strong border-t px-4 pt-3 pb-4">
      <ModelInfoPanel model={model} compact />
      <Button
        type="button"
        variant="default"
        size="sm"
        className="mt-3 w-full"
        onClick={(e) => {
          e.stopPropagation();
          onActivate();
        }}
        data-testid="row-expanded-use-button"
      >
        {expandedRowButtonLabel(pickerMode, isSelected, model.name)}
      </Button>
    </div>
  );
}

interface RowSecondaryAffordanceProps {
  modelName: string;
  isExpanded: boolean;
  isMobile: boolean;
  onShowInfo: () => void;
  onToggleExpand: () => void;
}

function RowSecondaryAffordance({
  modelName,
  isExpanded,
  isMobile,
  onShowInfo,
  onToggleExpand,
}: Readonly<RowSecondaryAffordanceProps>): React.JSX.Element {
  if (isMobile) {
    return (
      <RowChevronButton
        modelName={modelName}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      />
    );
  }
  return <RowInfoIconButton modelName={modelName} onShowInfo={onShowInfo} />;
}

function modelListItemRowClass(params: {
  isSelected: boolean;
  isFocused: boolean;
  isDisabled: boolean;
  isPulsing: boolean;
}): string {
  return cn(
    'group/row relative flex flex-col rounded-md transition-colors',
    params.isSelected && 'bg-accent/50',
    params.isFocused && 'ring-primary ring-2',
    params.isDisabled && 'pointer-events-none opacity-40',
    params.isPulsing && 'animate-picker-pulse'
  );
}

function ModelListItem({
  model,
  isFocused,
  isSelected,
  isDisabled,
  isPremium,
  canAccessPremium,
  isAuthenticated,
  isLinkGuest,
  pickerMode,
  pinnedLabel,
  isExpanded,
  isMobile,
  isPulsing,
  cascadeIndex,
  onActivate,
  onHover,
  onShowInfo,
  onToggleExpand,
}: Readonly<ModelListItemProps>): React.JSX.Element {
  const showOverlay = isPremium && !canAccessPremium && !isLinkGuest;
  const showInlineExpansion = isExpanded && isMobile;

  return (
    <div
      data-testid={`model-item-${model.id}`}
      data-selected={isSelected}
      data-expanded={isExpanded}
      data-pulsing={isPulsing ? 'true' : undefined}
      className={modelListItemRowClass({ isSelected, isFocused, isDisabled, isPulsing })}
      role="option"
      aria-selected={isSelected}
    >
      {showOverlay && (
        <div
          data-testid="premium-overlay"
          className="bg-background/60 pointer-events-none absolute inset-0 rounded-md"
        />
      )}

      <div className="flex">
        <RowMainButton
          model={model}
          pickerMode={pickerMode}
          isSelected={isSelected}
          isFocused={isFocused}
          isDisabled={isDisabled}
          showOverlay={showOverlay}
          isAuthenticated={isAuthenticated}
          pinnedLabel={pinnedLabel}
          cascadeIndex={cascadeIndex}
          onActivate={onActivate}
          onHover={onHover}
        />
        <RowSecondaryAffordance
          modelName={model.name}
          isExpanded={isExpanded}
          isMobile={isMobile}
          onShowInfo={onShowInfo}
          onToggleExpand={onToggleExpand}
        />
      </div>

      {showInlineExpansion && (
        <RowExpandedInfo
          model={model}
          pickerMode={pickerMode}
          isSelected={isSelected}
          onActivate={onActivate}
        />
      )}
    </div>
  );
}

interface SearchAndSortSectionProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortClick: (field: 'price' | 'context') => void;
  activeModality: Modality;
  /**
   * Optional element rendered to the right of the search input. Width animates
   * via the consumer (typically the multi-mode count chip).
   */
  rightAccessory?: React.ReactNode;
  /**
   * When false, omits the bottom divider so the section sits flush against the
   * parent's own border (used when wrapped in DesktopTopQuadrant, which owns
   * the divider for both desktop top quadrants).
   */
  withBottomBorder?: boolean;
}

function SearchAndSortSection({
  searchQuery,
  onSearchChange,
  sortField,
  sortDirection,
  onSortClick,
  activeModality,
  rightAccessory,
  withBottomBorder = true,
}: Readonly<SearchAndSortSectionProps>): React.JSX.Element {
  const showCapacityButton = activeModality === 'text';
  return (
    <div className={cn('border-border-strong space-y-2 px-4 py-2', withBottomBorder && 'border-b')}>
      <div
        className={cn(
          'items-center gap-2 pr-8 sm:pr-0',
          showCapacityButton ? 'grid grid-cols-[auto_1fr_1fr]' : 'grid grid-cols-[auto_1fr]'
        )}
      >
        <span className="text-muted-foreground text-xs font-medium">Sort:</span>
        <SortButton
          field="price"
          label="Price"
          activeField={sortField}
          direction={sortDirection}
          onClick={onSortClick}
        />
        {showCapacityButton && (
          <SortButton
            field="context"
            label="Capacity"
            activeField={sortField}
            direction={sortDirection}
            onClick={onSortClick}
          />
        )}
      </div>
      <div data-testid="search-and-sort-row" className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            type="text"
            placeholder="Search models"
            value={searchQuery}
            onChange={(e) => {
              onSearchChange(e.target.value);
            }}
            className="pl-9"
          />
        </div>
        {rightAccessory}
      </div>
    </div>
  );
}

interface UseFilteredModelsOptions {
  models: Model[];
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
  premiumIds: Set<string>;
  canAccessPremium: boolean;
  strongestId: string;
  valueId: string;
  /** Only show models matching this modality. Defaults to 'text'. */
  activeModality?: Modality | undefined;
}

/**
 * Assembles the final model list: Smart Model first (when present), then
 * pinned quick-select models (in default view only), then the remaining
 * interlaced list. Keeps `useFilteredModels` focused on filtering/sorting.
 */
function buildModelResultList(params: {
  interlaced: Model[];
  smartModel: Model | undefined;
  strongestId: string;
  valueId: string;
  isDefault: boolean;
}): Model[] {
  const { interlaced, smartModel, strongestId, valueId, isDefault } = params;
  const smartPrefix = smartModel ? [smartModel] : [];
  if (!isDefault) {
    return [...smartPrefix, ...interlaced];
  }
  const pinnedIds = [...new Set([strongestId, valueId])];
  const pinned = pinnedIds
    .map((id) => interlaced.find((m) => m.id === id))
    .filter((m): m is Model => m !== undefined);
  const remaining = interlaced.filter((m) => !pinnedIds.includes(m.id));
  return [...smartPrefix, ...pinned, ...remaining];
}

function useFilteredModels({
  models,
  searchQuery,
  sortField,
  sortDirection,
  premiumIds,
  canAccessPremium,
  strongestId,
  valueId,
  activeModality = 'text',
}: UseFilteredModelsOptions): Model[] {
  return React.useMemo(() => {
    const isDefault = sortField === null && !searchQuery.trim();

    // Filter to models matching the active modality. Smart Model is text-only.
    const modalityFiltered = models.filter((m) => m.modality === activeModality);
    const smartModel =
      activeModality === 'text' ? modalityFiltered.find((m) => m.isSmartModel === true) : undefined;
    const nonSmartModels = modalityFiltered.filter((m) => m.isSmartModel !== true);

    const result = filterBySearch(nonSmartModels, searchQuery);
    const sorted = sortModels(result, sortField, sortDirection, activeModality);
    const interlaced = interlaceModels(sorted, premiumIds, canAccessPremium);

    return buildModelResultList({ interlaced, smartModel, strongestId, valueId, isDefault });
  }, [
    models,
    searchQuery,
    sortField,
    sortDirection,
    premiumIds,
    canAccessPremium,
    strongestId,
    valueId,
    activeModality,
  ]);
}

function getPinnedLabelForModel(
  modelId: string,
  strongestId: string,
  valueId: string
): string | undefined {
  if (modelId === strongestId) return 'Strongest';
  if (modelId === valueId) return 'Best value';
  return undefined;
}

function toggleSortDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

function buildSelectedEntries(
  selectedIds: Set<string>,
  models: Model[]
): { id: string; name: string }[] {
  return [...selectedIds]
    .map((id) => {
      const model = models.find((m) => m.id === id);
      return model ? { id: model.id, name: model.name } : null;
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);
}

function updateSelectedIds(previous: Set<string>, modelId: string): Set<string> {
  const next = new Set(previous);
  if (next.has(modelId)) {
    next.delete(modelId);
  } else {
    if (next.size >= MAX_SELECTED_MODELS) return previous;
    next.add(modelId);
  }
  return next;
}

interface ModelSelectorFooterProps {
  selectedCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Multi-mode footer. Single mode hides the footer entirely (row click commits +
 * closes, so there's no pending state to confirm or discard).
 *
 * Slides up from below when entering — gives the visual cue that the user has
 * a pending state to confirm. The slide collapses to instant under
 * `prefers-reduced-motion`.
 */
function ModelSelectorFooter({
  selectedCount,
  onCancel,
  onConfirm,
}: Readonly<ModelSelectorFooterProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion() ?? false;
  const useLabel = selectedCount === 1 ? 'Use 1 model' : `Use ${String(selectedCount)} models`;
  return (
    <motion.div
      data-testid="model-selector-footer-motion"
      initial={reduceMotion ? false : { y: 24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { y: 24, opacity: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: 'easeOut' }}
      className="border-t p-4"
    >
      <ModalActions
        cancel={{
          label: 'Cancel',
          onClick: onCancel,
          testId: 'cancel-button',
        }}
        primary={{
          label: useLabel,
          onClick: onConfirm,
          testId: 'use-models-button',
        }}
      />
    </motion.div>
  );
}

interface MultiCountChipProps {
  selectedCount: number;
  onClear: () => void;
}

function MultiCountChip({
  selectedCount,
  onClear,
}: Readonly<MultiCountChipProps>): React.JSX.Element {
  return (
    <motion.span
      data-testid="picker-mode-counter"
      layout
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: 'auto' }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ duration: 0.18 }}
      className="text-muted-foreground inline-flex flex-shrink-0 items-center gap-1 overflow-hidden text-xs whitespace-nowrap"
    >
      <span>{`${String(selectedCount)} of ${String(MAX_SELECTED_MODELS)}`}</span>
      {selectedCount > 0 && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            data-testid="clear-selection-button"
            onClick={onClear}
            className="text-primary cursor-pointer underline-offset-2 hover:underline"
          >
            Clear
          </button>
        </>
      )}
    </motion.span>
  );
}

function initialFocusedId(selectedIds: Set<string>, models: Model[]): string {
  const firstSelected = selectedIds.values().next().value;
  if (firstSelected !== undefined) return firstSelected;
  return models[0]?.id ?? '';
}

interface ModelListBodyProps {
  filteredModels: Model[];
  pickerMode: PickerMode;
  selectedIds: Set<string>;
  localSelectedIds: Set<string>;
  focusedModelId: string;
  expandedModelId: string | null;
  isPremium: (modelId: string) => boolean;
  canAccessPremium: boolean;
  isAuthenticated: boolean;
  isLinkGuest: boolean;
  isMobile: boolean;
  pulsingModelId: string | null;
  getPinnedLabel: (modelId: string) => string | undefined;
  onActivate: (modelId: string) => void;
  onHover: (modelId: string) => void;
  onShowInfo: (modelId: string) => void;
  onToggleExpand: (modelId: string) => void;
}

function ModelListBody(props: Readonly<ModelListBodyProps>): React.JSX.Element {
  const {
    filteredModels,
    pickerMode,
    selectedIds,
    localSelectedIds,
    focusedModelId,
    expandedModelId,
    isPremium,
    canAccessPremium,
    isAuthenticated,
    isLinkGuest,
    isMobile,
    pulsingModelId,
    getPinnedLabel,
    onActivate,
    onHover,
    onShowInfo,
    onToggleExpand,
  } = props;
  const isAtLimit = pickerMode === 'multi' && localSelectedIds.size >= MAX_SELECTED_MODELS;

  return (
    <div
      className="overflow-hidden p-2 pr-3"
      role="listbox"
      aria-label="Models"
      aria-multiselectable={pickerMode === 'multi'}
    >
      {filteredModels.map((model, cascadeIndex) => {
        const isSelected =
          pickerMode === 'multi' ? localSelectedIds.has(model.id) : selectedIds.has(model.id);
        return (
          <ModelListItem
            key={model.id}
            model={model}
            isFocused={model.id === focusedModelId}
            isSelected={isSelected}
            isDisabled={isAtLimit && !localSelectedIds.has(model.id)}
            isPremium={isPremium(model.id)}
            canAccessPremium={canAccessPremium}
            isAuthenticated={isAuthenticated}
            isLinkGuest={isLinkGuest}
            pickerMode={pickerMode}
            pinnedLabel={getPinnedLabel(model.id)}
            isExpanded={expandedModelId === model.id}
            isMobile={isMobile}
            isPulsing={model.id === pulsingModelId}
            cascadeIndex={cascadeIndex}
            onActivate={() => {
              onActivate(model.id);
            }}
            onHover={() => {
              onHover(model.id);
            }}
            onShowInfo={() => {
              onShowInfo(model.id);
            }}
            onToggleExpand={() => {
              onToggleExpand(model.id);
            }}
          />
        );
      })}
      {filteredModels.length === 0 && (
        <div className="text-muted-foreground p-4 text-center text-sm">No models found</div>
      )}
    </div>
  );
}

interface MobileTopSectionProps {
  pickerMode: PickerMode;
  onModeChange: (mode: PickerMode) => void;
  multiLabel: React.ReactNode;
  searchAndSortProps: SearchAndSortSectionProps;
}

function MobileTopSection({
  pickerMode,
  onModeChange,
  multiLabel,
  searchAndSortProps,
}: Readonly<MobileTopSectionProps>): React.JSX.Element {
  return (
    <div className="flex flex-shrink-0 flex-col">
      <div className="border-border-strong border-b py-2">
        <div
          data-testid="picker-mode-toggle-wrapper"
          className="mx-auto w-full max-w-[calc(100%-3rem)] px-4"
        >
          <PickerModeToggle
            mode={pickerMode}
            onChange={onModeChange}
            orientation="horizontal"
            singleLabel="Talk to one model"
            multiLabel={multiLabel}
          />
        </div>
      </div>
      <SearchAndSortSection {...searchAndSortProps} />
    </div>
  );
}

const PICKER_PULSE_DURATION_MS = 600;

interface ModeChangeHandlerParams {
  setPickerMode: (modality: Modality, mode: PickerMode) => void;
  resolvedModality: Modality;
  localSelectedIds: Set<string>;
  setLocalSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  models: Model[];
  onSelect: (models: { id: string; name: string }[]) => void;
}

/**
 * Handles the picker mode toggle. On multi → single with >1 selected, auto-
 * collapses local + committed selection to the first model so the displayed
 * mode and committed state stay in sync.
 */
function useModeChangeHandler({
  setPickerMode,
  resolvedModality,
  localSelectedIds,
  setLocalSelectedIds,
  models,
  onSelect,
}: ModeChangeHandlerParams): (next: PickerMode) => void {
  return React.useCallback(
    (next: PickerMode): void => {
      const shouldCollapse = next === 'single' && localSelectedIds.size > 1;
      if (shouldCollapse) {
        const firstId = localSelectedIds.values().next().value;
        if (firstId !== undefined) {
          const collapsed = new Set([firstId]);
          setLocalSelectedIds(collapsed);
          onSelect(buildSelectedEntries(collapsed, models));
        }
      }
      setPickerMode(resolvedModality, next);
    },
    [setPickerMode, resolvedModality, localSelectedIds, setLocalSelectedIds, models, onSelect]
  );
}

/**
 * Highlights the carryover-selected row briefly when the picker transitions
 * single → multi. Returns the model id to pulse, or null when no pulse should
 * play. Resets when the modal closes so a re-open in multi mode doesn't pulse.
 */
function useCarryoverPulse(
  pickerMode: PickerMode,
  selectedIds: Set<string>,
  isOpen: boolean
): string | null {
  const [pulsingModelId, setPulsingModelId] = React.useState<string | null>(null);
  const previousModeReference = React.useRef<PickerMode>(pickerMode);

  React.useEffect(() => {
    if (!isOpen) {
      previousModeReference.current = pickerMode;
      setPulsingModelId(null);
      return;
    }
    const previous = previousModeReference.current;
    previousModeReference.current = pickerMode;
    if (previous !== 'single' || pickerMode !== 'multi') return;
    const firstId = selectedIds.values().next().value;
    if (firstId === undefined) return;
    setPulsingModelId(firstId);
    const timer = setTimeout(() => {
      setPulsingModelId(null);
    }, PICKER_PULSE_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pickerMode, selectedIds, isOpen]);

  return pulsingModelId;
}

/**
 * Single source of truth for the desktop top-quadrant height. Both the
 * left search/sort section and the right toggle header wrap their content in
 * a `<DesktopTopQuadrant>` so the two columns stay in visual lock-step.
 */
const DESKTOP_TOP_QUADRANT_HEIGHT_CLASS = 'h-[6rem]';

function DesktopTopQuadrant({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div
      data-testid="desktop-top-quadrant"
      className={cn(
        'border-border-strong flex flex-shrink-0 items-center overflow-hidden border-b',
        DESKTOP_TOP_QUADRANT_HEIGHT_CLASS
      )}
    >
      <div className="w-full">{children}</div>
    </div>
  );
}

interface DesktopRightColumnProps {
  pickerMode: PickerMode;
  onModeChange: (mode: PickerMode) => void;
  multiLabel: React.ReactNode;
  focusedModel: Model | undefined;
}

function DesktopRightColumn({
  pickerMode,
  onModeChange,
  multiLabel,
  focusedModel,
}: Readonly<DesktopRightColumnProps>): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-w-sm flex-1 flex-[11] flex-col">
      <DesktopTopQuadrant>
        <div className="py-2">
          <div
            data-testid="picker-mode-toggle-wrapper"
            className="mx-auto w-full max-w-[calc(100%-3rem)] px-4"
          >
            <PickerModeToggle
              mode={pickerMode}
              onChange={onModeChange}
              orientation="vertical"
              singleLabel="Talk to one model"
              multiLabel={multiLabel}
            />
          </div>
        </div>
      </DesktopTopQuadrant>
      <ScrollArea data-testid="model-details-panel" className="min-h-0 flex-1">
        <div className="p-6">{focusedModel ? <ModelInfoPanel model={focusedModel} /> : null}</div>
      </ScrollArea>
    </div>
  );
}

interface ModelSelectorModalLayoutProps {
  isMobile: boolean;
  pickerMode: PickerMode;
  multiLabel: React.ReactNode;
  searchAndSortProps: SearchAndSortSectionProps;
  handleModeChange: (mode: PickerMode) => void;
  focusedModel: Model | undefined;
  modelListBodyProps: ModelListBodyProps;
  footer: React.ReactNode;
}

function ModelSelectorModalLayout({
  isMobile,
  pickerMode,
  multiLabel,
  searchAndSortProps,
  handleModeChange,
  focusedModel,
  modelListBodyProps,
  footer,
}: Readonly<ModelSelectorModalLayoutProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'bg-background flex w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border shadow-lg',
        isMobile ? 'h-[92dvh]' : 'h-[85dvh]'
      )}
      data-testid="model-selector-modal"
      data-picker-mode={pickerMode}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {isMobile && (
          <MobileTopSection
            pickerMode={pickerMode}
            onModeChange={handleModeChange}
            multiLabel={multiLabel}
            searchAndSortProps={searchAndSortProps}
          />
        )}

        <div className={cn('flex min-h-0 min-w-0 flex-1', isMobile ? 'flex-col' : 'flex-row')}>
          <div
            data-testid="model-list-panel"
            className={cn(
              'border-border-strong flex min-h-0 min-w-0 flex-col overflow-x-hidden',
              isMobile ? 'flex-[9] border-b' : 'flex-1 border-r'
            )}
          >
            {!isMobile && (
              <DesktopTopQuadrant>
                <SearchAndSortSection {...searchAndSortProps} withBottomBorder={false} />
              </DesktopTopQuadrant>
            )}

            <ScrollArea data-testid="model-list-scroll" className="min-h-0 flex-1">
              <ModelListBody {...modelListBodyProps} />
            </ScrollArea>
          </div>

          {!isMobile && (
            <DesktopRightColumn
              pickerMode={pickerMode}
              onModeChange={handleModeChange}
              multiLabel={multiLabel}
              focusedModel={focusedModel}
            />
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}

interface ModelSelectorModalProps extends ModelSelectorGatingProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedIds: Set<string>;
  onSelect: (models: { id: string; name: string }[]) => void;
  /** Filter models to match this modality. Defaults to 'text' for back-compat. */
  activeModality?: Modality;
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
  canAccessPremium = true,
  isAuthenticated = true,
  isLinkGuest,
  onPremiumClick,
  activeModality,
}: Readonly<ModelSelectorModalProps>): React.JSX.Element {
  const isMobile = useIsMobile();
  const resolvedModality = resolveModality(activeModality);
  const pickerMode = useModelStore((s) => s.pickerMode[resolvedModality]);
  const setPickerMode = useModelStore((s) => s.setPickerMode);

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
  const { strongestId, valueId } = React.useMemo(
    () => getAccessibleModelIds(models, premiumIds ?? new Set(), canAccessPremium, activeModality),
    [models, premiumIds, canAccessPremium, activeModality]
  );

  const filteredModels = useFilteredModels({
    models,
    searchQuery,
    sortField,
    sortDirection,
    premiumIds: premiumIds ?? new Set(),
    canAccessPremium,
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

  const isPremium = React.useCallback(
    (modelId: string): boolean => premiumIds?.has(modelId) ?? false,
    [premiumIds]
  );

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

  const isPremiumGated = React.useCallback(
    (modelId: string): boolean =>
      !isLinkGuest && !canAccessPremium && (premiumIds?.has(modelId) ?? false),
    [isLinkGuest, canAccessPremium, premiumIds]
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

      if (isPremiumGated(modelId)) {
        onPremiumClick?.(modelId);
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
      isPremiumGated,
      onPremiumClick,
      pickerMode,
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
            pickerMode,
            selectedIds,
            localSelectedIds,
            focusedModelId,
            expandedModelId,
            isPremium,
            canAccessPremium,
            isAuthenticated,
            isLinkGuest: isLinkGuest ?? false,
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
