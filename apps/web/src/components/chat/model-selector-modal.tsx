import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Search, ChevronUp, ChevronDown, Lock, Square, CheckSquare } from 'lucide-react';
import { ModalOverlay, Input, Button, ModalActions, ScrollArea, cn } from '@hushbox/ui';
import type { Model } from '@hushbox/shared';
import {
  ROUTES,
  MAX_SELECTED_MODELS,
  getModelCostPer1k,
  shortenModelName,
  modelSupportsCapability,
} from '@hushbox/shared';
import { formatContextLength } from '../../lib/format';
import { getAccessibleModelIds } from '../../hooks/models';
import { useIsMobile } from '../../hooks/use-is-mobile';

import { ModelInfoPanel } from './model-info-panel';

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

function sortModels(models: Model[], sortField: SortField, sortDirection: SortDirection): Model[] {
  if (!sortField) {
    return models;
  }
  return [...models].toSorted((a, b) => {
    let comparison = 0;
    if (sortField === 'price') {
      const priceA = getModelCostPer1k(a.pricePerInputToken, a.pricePerOutputToken);
      const priceB = getModelCostPer1k(b.pricePerInputToken, b.pricePerOutputToken);
      comparison = priceA - priceB;
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

function ModelItemDetails({
  model,
  showOverlay,
  isAuthenticated,
  pinnedLabel,
}: Readonly<ModelItemDetailsProps>): React.JSX.Element {
  const supportsWebSearch = modelSupportsCapability(model, 'web-search');
  return (
    <div className="text-muted-foreground relative flex items-center justify-between text-xs">
      <span className="truncate">
        {model.isAutoRouter ? (
          'Auto-picks the best model'
        ) : (
          <>
            {model.provider} • Capacity: {formatContextLength(model.contextLength)}
            {supportsWebSearch && ' • Web Search'}
          </>
        )}
      </span>
      {showOverlay && <ModelItemOverlay isAuthenticated={isAuthenticated} />}
      {!showOverlay && pinnedLabel && (
        <span className="text-muted-foreground shrink-0 text-xs">{pinnedLabel}</span>
      )}
    </div>
  );
}

interface ModelItemContentProps {
  model: Model;
  isFocused: boolean;
  isSelected: boolean;
  isDisabled: boolean;
  showOverlay: boolean;
  isAuthenticated: boolean;
  pinnedLabel?: string | undefined;
  onClick: () => void;
  onDoubleClick: () => void;
}

function ModelItemContent({
  model,
  isFocused,
  isSelected,
  isDisabled,
  showOverlay,
  isAuthenticated,
  pinnedLabel,
  onClick,
  onDoubleClick,
}: Readonly<ModelItemContentProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex-1 cursor-pointer rounded-l-md p-3 transition-colors',
        !isSelected && !isFocused && !isDisabled && 'hover:bg-muted'
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
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
  pinnedLabel?: string | undefined;
  onClick: () => void;
  onDoubleClick: () => void;
}

function ModelListItem({
  model,
  isFocused,
  isSelected,
  isDisabled,
  isPremium,
  canAccessPremium,
  isAuthenticated,
  pinnedLabel,
  onClick,
  onDoubleClick,
}: Readonly<ModelListItemProps>): React.JSX.Element {
  const showOverlay = isPremium && !canAccessPremium;

  return (
    <div
      data-testid={`model-item-${model.id}`}
      data-selected={isSelected}
      className={cn(
        'group/row relative flex rounded-md transition-colors',
        isSelected && 'bg-accent/50',
        isFocused && 'ring-primary ring-2',
        isDisabled && 'pointer-events-none opacity-40'
      )}
      role="option"
      aria-selected={isSelected}
    >
      {showOverlay && (
        <div
          data-testid="premium-overlay"
          className="bg-background/60 pointer-events-none absolute inset-0 rounded-md"
        />
      )}

      <ModelItemContent
        model={model}
        isFocused={isFocused}
        isSelected={isSelected}
        isDisabled={isDisabled}
        showOverlay={showOverlay}
        isAuthenticated={isAuthenticated}
        pinnedLabel={pinnedLabel}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />

      <button
        data-testid="model-checkbox"
        type="button"
        className={cn(
          'relative flex w-10 cursor-pointer items-center justify-center self-stretch rounded-r-md transition-colors',
          !isDisabled && 'hover:bg-muted/50'
        )}
        onClick={(e) => {
          e.stopPropagation();
          onDoubleClick();
        }}
      >
        {isSelected ? (
          <CheckSquare className="text-primary h-4 w-4" />
        ) : (
          <Square className="text-muted-foreground h-4 w-4" />
        )}
      </button>
    </div>
  );
}

interface SearchAndSortSectionProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortClick: (field: 'price' | 'context') => void;
  webSearchFilter: boolean;
  onToggleWebSearch: () => void;
}

function SearchAndSortSection({
  searchQuery,
  onSearchChange,
  sortField,
  sortDirection,
  onSortClick,
  webSearchFilter,
  onToggleWebSearch,
}: Readonly<SearchAndSortSectionProps>): React.JSX.Element {
  return (
    <div className="border-border-strong grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2 border-b px-4 py-2 sm:grid-cols-[auto_1fr_1fr]">
      <span className="text-muted-foreground text-xs font-medium">Sort:</span>
      <SortButton
        field="price"
        label="Price"
        activeField={sortField}
        direction={sortDirection}
        onClick={onSortClick}
      />
      <SortButton
        field="context"
        label="Capacity"
        activeField={sortField}
        direction={sortDirection}
        onClick={onSortClick}
      />
      <div className="sm:hidden" />

      <div className="relative col-span-3 sm:col-span-2">
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
      <Button
        variant={webSearchFilter ? 'default' : 'outline'}
        size="sm"
        onClick={onToggleWebSearch}
        aria-label={webSearchFilter ? 'Web search filter on' : 'Web search filter off'}
      >
        Web Search
      </Button>
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
  webSearchFilter: boolean;
  strongestId: string;
  valueId: string;
}

function useFilteredModels({
  models,
  searchQuery,
  sortField,
  sortDirection,
  premiumIds,
  canAccessPremium,
  webSearchFilter,
  strongestId,
  valueId,
}: UseFilteredModelsOptions): Model[] {
  return React.useMemo(() => {
    const isDefault = sortField === null && !searchQuery.trim() && !webSearchFilter;

    const autoRouter = models.find((m) => m.isAutoRouter === true);
    const nonAutoModels = models.filter((m) => m.isAutoRouter !== true);

    let result = filterBySearch(nonAutoModels, searchQuery);
    if (webSearchFilter) {
      result = result.filter((m) => modelSupportsCapability(m, 'web-search'));
    }
    const sorted = sortModels(result, sortField, sortDirection);
    const interlaced = interlaceModels(sorted, premiumIds, canAccessPremium);

    if (isDefault) {
      const pinnedIds = [...new Set([strongestId, valueId])];
      const pinned = pinnedIds
        .map((id) => interlaced.find((m) => m.id === id))
        .filter((m): m is Model => m !== undefined);
      const remaining = interlaced.filter((m) => !pinnedIds.includes(m.id));
      return [...(autoRouter ? [autoRouter] : []), ...pinned, ...remaining];
    }
    return [...(autoRouter ? [autoRouter] : []), ...interlaced];
  }, [
    models,
    searchQuery,
    sortField,
    sortDirection,
    premiumIds,
    canAccessPremium,
    webSearchFilter,
    strongestId,
    valueId,
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
    if (next.size <= 1) return previous;
    next.delete(modelId);
  } else {
    if (next.size >= MAX_SELECTED_MODELS) return previous;
    next.add(modelId);
  }
  return next;
}

interface ModelSelectorFooterProps {
  selectedCount: number;
  onClear: () => void;
  onConfirm: () => void;
}

function ModelSelectorFooter({
  selectedCount,
  onClear,
  onConfirm,
}: Readonly<ModelSelectorFooterProps>): React.JSX.Element {
  return (
    <div className="border-t p-4">
      <ModalActions
        {...(selectedCount >= 1 && {
          cancel: {
            label: 'Clear Selected',
            onClick: onClear,
            testId: 'clear-selection-button',
          },
        })}
        primary={{
          label: selectedCount > 1 ? `Select ${String(selectedCount)} Models` : 'Select Model',
          onClick: onConfirm,
        }}
      />
    </div>
  );
}

interface ModelSelectorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedIds: Set<string>;
  onSelect: (models: { id: string; name: string }[]) => void;
  /** Set of premium model IDs */
  premiumIds?: Set<string> | undefined;
  /** Whether the user can access premium models (defaults to true) */
  canAccessPremium?: boolean | undefined;
  /** Whether the user is authenticated (defaults to true) */
  isAuthenticated?: boolean | undefined;
  /** Called when user clicks a premium model they cannot access */
  onPremiumClick?: ((modelId: string) => void) | undefined;
}

/**
 * Model selector modal with search, quick-select buttons, and model details.
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
  onPremiumClick,
}: Readonly<ModelSelectorModalProps>): React.JSX.Element {
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [focusedModelId, setFocusedModelId] = React.useState(
    selectedIds.values().next().value ?? models[0]?.id ?? ''
  );
  const [sortField, setSortField] = React.useState<SortField>(null);
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('asc');
  const [webSearchFilter, setWebSearchFilter] = React.useState(false);
  const [localSelectedIds, setLocalSelectedIds] = React.useState<Set<string>>(new Set(selectedIds));

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      setLocalSelectedIds(new Set(selectedIds));
      setFocusedModelId(selectedIds.values().next().value ?? models[0]?.id ?? '');
      setSearchQuery('');
      setWebSearchFilter(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- models is a fallback; re-running on models change would reset user's selection
  }, [open, selectedIds]);

  // Calculate quick select model IDs based on user tier
  const { strongestId, valueId } = React.useMemo(
    () => getAccessibleModelIds(models, premiumIds ?? new Set(), canAccessPremium),
    [models, premiumIds, canAccessPremium]
  );

  const filteredModels = useFilteredModels({
    models,
    searchQuery,
    sortField,
    sortDirection,
    premiumIds: premiumIds ?? new Set(),
    canAccessPremium,
    webSearchFilter,
    strongestId,
    valueId,
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

  const handleFocusModel = React.useCallback((modelId: string): void => {
    setFocusedModelId(modelId);
  }, []);

  const handleToggleModel = React.useCallback(
    (modelId: string): void => {
      if (!canAccessPremium && premiumIds?.has(modelId)) {
        onPremiumClick?.(modelId);
        return;
      }

      setFocusedModelId(modelId);
      setLocalSelectedIds((previous) => updateSelectedIds(previous, modelId));
    },
    [canAccessPremium, premiumIds, onPremiumClick]
  );

  const handleConfirmSelection = React.useCallback((): void => {
    onSelect(buildSelectedEntries(localSelectedIds, models));
    onOpenChange(false);
  }, [localSelectedIds, models, onSelect, onOpenChange]);

  const handleClearSelection = React.useCallback((): void => {
    setLocalSelectedIds(new Set());
  }, []);

  const handleToggleWebSearch = React.useCallback((): void => {
    setWebSearchFilter((previous) => !previous);
  }, []);

  // Prevent auto-focus on mobile to avoid triggering keyboard
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isMobile) {
        event.preventDefault();
      }
    },
    [isMobile]
  );

  return (
    <ModalOverlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Select model"
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <div
        className="bg-background flex h-[92dvh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border shadow-lg sm:h-[85dvh]"
        data-testid="model-selector-modal"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-shrink-0 sm:hidden">
            <SearchAndSortSection
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sortField={sortField}
              sortDirection={sortDirection}
              onSortClick={handleSortClick}
              webSearchFilter={webSearchFilter}
              onToggleWebSearch={handleToggleWebSearch}
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <div
              data-testid="model-list-panel"
              className="border-border-strong flex min-h-0 flex-[9] flex-col border-b sm:flex-1 sm:border-r sm:border-b-0"
            >
              <div className="hidden flex-shrink-0 sm:block">
                <SearchAndSortSection
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSortClick={handleSortClick}
                  webSearchFilter={webSearchFilter}
                  onToggleWebSearch={handleToggleWebSearch}
                />
              </div>

              <ScrollArea data-testid="model-list-scroll" className="min-h-0 flex-1">
                <div className="p-2">
                  {filteredModels.map((model) => {
                    const isAtLimit = localSelectedIds.size >= MAX_SELECTED_MODELS;
                    return (
                      <ModelListItem
                        key={model.id}
                        model={model}
                        isFocused={model.id === focusedModelId}
                        isSelected={localSelectedIds.has(model.id)}
                        isDisabled={isAtLimit && !localSelectedIds.has(model.id)}
                        isPremium={isPremium(model.id)}
                        canAccessPremium={canAccessPremium}
                        isAuthenticated={isAuthenticated}
                        pinnedLabel={getPinnedLabel(model.id)}
                        onClick={() => {
                          handleFocusModel(model.id);
                        }}
                        onDoubleClick={() => {
                          handleToggleModel(model.id);
                        }}
                      />
                    );
                  })}
                  {filteredModels.length === 0 && (
                    <div className="text-muted-foreground p-4 text-center text-sm">
                      No models found
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Right panel: Model details - takes 60% on mobile, constrained on desktop */}
            <ScrollArea
              data-testid="model-details-panel"
              className="min-h-0 flex-[11] sm:max-w-sm sm:flex-1"
            >
              <div className="p-6">
                {focusedModel ? <ModelInfoPanel model={focusedModel} /> : null}
              </div>
            </ScrollArea>
          </div>
        </div>

        <ModelSelectorFooter
          selectedCount={localSelectedIds.size}
          onClear={handleClearSelection}
          onConfirm={handleConfirmSelection}
        />
      </div>
    </ModalOverlay>
  );
}
