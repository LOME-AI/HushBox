import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Search, ChevronUp, ChevronDown, Lock } from 'lucide-react';
import { ModalOverlay, Input, Badge, Button, ModalActions, ScrollArea } from '@hushbox/ui';
import type { Model } from '@hushbox/shared';
import {
  ROUTES,
  formatNumber,
  getModelCostPer1k,
  isExpensiveModel,
  shortenModelName,
} from '@hushbox/shared';
import { applyFees, formatContextLength, formatPricePer1k } from '../../lib/format';
import { getAccessibleModelIds } from '../../hooks/models';
import { useIsMobile } from '../../hooks/use-is-mobile';

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
      className="gap-1"
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

interface ModelListItemProps {
  model: Model;
  isFocused: boolean;
  isPremium: boolean;
  canAccessPremium: boolean;
  isAuthenticated: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

function ModelListItem({
  model,
  isFocused,
  isPremium,
  canAccessPremium,
  isAuthenticated,
  onClick,
  onDoubleClick,
}: Readonly<ModelListItemProps>): React.JSX.Element {
  const showOverlay = isPremium && !canAccessPremium;

  return (
    <div
      data-testid={`model-item-${model.id}`}
      data-selected={isFocused}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`relative cursor-pointer rounded-md p-3 transition-colors ${
        isFocused ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      }`}
      role="option"
      aria-selected={isFocused}
    >
      {showOverlay && (
        <div
          data-testid="premium-overlay"
          className="bg-background/60 pointer-events-none absolute inset-0 rounded-md"
        />
      )}

      <div className="relative flex items-center justify-between gap-2">
        <span className="truncate font-medium">{shortenModelName(model.name)}</span>
        {showOverlay && (
          <Lock data-testid="lock-icon" className="text-muted-foreground h-4 w-4 shrink-0" />
        )}
      </div>
      <div className="text-muted-foreground relative flex items-center justify-between text-xs">
        <span className="truncate">
          {model.provider} • Capacity: {formatContextLength(model.contextLength)}
        </span>
        {showOverlay && (
          <span className="shrink-0 text-xs">
            {isAuthenticated ? (
              <>
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
              </>
            ) : (
              <>
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
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

interface SearchAndSortSectionProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortClick: (field: 'price' | 'context') => void;
  strongestId: string;
  valueId: string;
  onQuickSelect: (modelId: string) => void;
  isMobile?: boolean;
}

function SearchAndSortSection({
  searchQuery,
  onSearchChange,
  sortField,
  sortDirection,
  onSortClick,
  strongestId,
  valueId,
  onQuickSelect,
  isMobile = false,
}: Readonly<SearchAndSortSectionProps>): React.JSX.Element {
  const padding = isMobile ? 'px-4 py-2' : 'p-4';
  const marginBottom = isMobile ? 'mb-1' : 'mb-2';

  return (
    <>
      <div className={`border-border-strong border-b ${padding}`}>
        <div className={`text-muted-foreground ${marginBottom} text-xs font-medium uppercase`}>
          Quick Select Model
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onQuickSelect(strongestId);
            }}
            className="flex-1"
            data-testid={isMobile ? 'quick-select-strongest' : 'quick-select-strongest-desktop'}
          >
            Strongest
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onQuickSelect(valueId);
            }}
            className="flex-1"
            data-testid={isMobile ? 'quick-select-value' : 'quick-select-value-desktop'}
          >
            Value
          </Button>
        </div>
      </div>

      <div className={`border-border-strong border-b ${padding}`}>
        <div className={`text-muted-foreground ${marginBottom} text-xs font-medium uppercase`}>
          Sort By
        </div>
        <div className="grid grid-cols-2 gap-2">
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
        </div>
      </div>

      <div className={`border-border-strong border-b px-4 py-2`}>
        <div className="relative">
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
      </div>
    </>
  );
}

interface ModelSelectorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedId: string;
  onSelect: (modelId: string) => void;
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
  selectedId,
  onSelect,
  premiumIds,
  canAccessPremium = true,
  isAuthenticated = true,
  onPremiumClick,
}: Readonly<ModelSelectorModalProps>): React.JSX.Element {
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [focusedModelId, setFocusedModelId] = React.useState(selectedId);
  const [sortField, setSortField] = React.useState<SortField>(null);
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('asc');

  // Reset focused model when modal opens
  React.useEffect(() => {
    if (open) {
      setFocusedModelId(selectedId);
      setSearchQuery('');
    }
  }, [open, selectedId]);

  // Filter and sort models
  const filteredModels = React.useMemo(() => {
    const searched = filterBySearch(models, searchQuery);
    const sorted = sortModels(searched, sortField, sortDirection);
    return interlaceModels(sorted, premiumIds ?? new Set(), canAccessPremium);
  }, [models, searchQuery, sortField, sortDirection, premiumIds, canAccessPremium]);

  const handleSortClick = React.useCallback(
    (field: 'price' | 'context'): void => {
      if (sortField === field) {
        // Toggle direction if same field
        setSortDirection((previous) => (previous === 'asc' ? 'desc' : 'asc'));
      } else {
        // Activate new field with ascending
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField]
  );

  // Calculate quick select model IDs based on user tier
  const { strongestId, valueId } = React.useMemo(
    () => getAccessibleModelIds(models, premiumIds ?? new Set(), canAccessPremium),
    [models, premiumIds, canAccessPremium]
  );

  const focusedModel = models.find((m) => m.id === focusedModelId) ?? models[0];

  const isPremium = React.useCallback(
    (modelId: string): boolean => {
      return premiumIds?.has(modelId) ?? false;
    },
    [premiumIds]
  );

  const isFocusedPremium = isPremium(focusedModelId);

  const handleModelClick = React.useCallback((modelId: string): void => {
    setFocusedModelId(modelId);
  }, []);

  const handleModelDoubleClick = React.useCallback(
    (modelId: string): void => {
      // If user can't access premium and clicks a premium model, route to premium handler
      if (!canAccessPremium && premiumIds?.has(modelId)) {
        onPremiumClick?.(modelId);
        return;
      }
      onSelect(modelId);
      onOpenChange(false);
    },
    [canAccessPremium, premiumIds, onPremiumClick, onSelect, onOpenChange]
  );

  const handleQuickSelect = React.useCallback(
    (modelId: string): void => {
      onSelect(modelId);
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  const handleSelectButton = React.useCallback((): void => {
    // If user can't access premium and focused model is premium, route to premium handler
    if (!canAccessPremium && isFocusedPremium) {
      onPremiumClick?.(focusedModelId);
      return;
    }
    onSelect(focusedModelId);
    onOpenChange(false);
  }, [canAccessPremium, isFocusedPremium, focusedModelId, onPremiumClick, onSelect, onOpenChange]);

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
        className="bg-background flex h-[85vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border shadow-lg sm:h-[80vh]"
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
              strongestId={strongestId}
              valueId={valueId}
              onQuickSelect={handleQuickSelect}
              isMobile
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
                  strongestId={strongestId}
                  valueId={valueId}
                  onQuickSelect={handleQuickSelect}
                />
              </div>

              <ScrollArea data-testid="model-list-scroll" className="min-h-0 flex-1">
                <div className="p-2">
                  {filteredModels.map((model) => (
                    <ModelListItem
                      key={model.id}
                      model={model}
                      isFocused={model.id === focusedModelId}
                      isPremium={isPremium(model.id)}
                      canAccessPremium={canAccessPremium}
                      isAuthenticated={isAuthenticated}
                      onClick={() => {
                        handleModelClick(model.id);
                      }}
                      onDoubleClick={() => {
                        handleModelDoubleClick(model.id);
                      }}
                    />
                  ))}
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
                {focusedModel && (
                  <div className="space-y-6">
                    {/* Provider */}
                    <div>
                      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                        Provider
                      </div>
                      <div className="text-lg font-medium break-words">{focusedModel.provider}</div>
                    </div>

                    {/* Input Price */}
                    <div>
                      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                        Input Price / Token
                      </div>
                      <div className="text-lg font-medium">
                        {formatPricePer1k(applyFees(focusedModel.pricePerInputToken))} / 1k
                      </div>
                    </div>

                    {/* Output Price */}
                    <div>
                      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                        Output Price / Token
                      </div>
                      <div className="text-lg font-medium">
                        {formatPricePer1k(applyFees(focusedModel.pricePerOutputToken))} / 1k
                      </div>
                    </div>

                    {/* Expensive Model Warning */}
                    {isExpensiveModel(
                      focusedModel.pricePerInputToken,
                      focusedModel.pricePerOutputToken
                    ) && (
                      <p
                        className="-mt-6 mb-1 text-sm text-amber-500"
                        data-testid="expensive-model-warning"
                      >
                        Long chats with this model can be costly
                      </p>
                    )}

                    {/* Capacity Limit */}
                    <div>
                      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                        Capacity Limit
                      </div>
                      <div className="text-lg font-medium">
                        {formatNumber(focusedModel.contextLength)} tokens
                      </div>
                    </div>

                    {/* Capabilities */}
                    {focusedModel.capabilities.length > 0 && (
                      <div>
                        <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                          Capabilities
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {focusedModel.capabilities.map((cap) => (
                            <Badge key={cap} variant="secondary">
                              {cap}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Description */}
                    <div>
                      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                        Description
                      </div>
                      <div className="overflow-hidden text-sm break-words">
                        {focusedModel.description}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        {/* Bottom button - full width */}
        <div className="border-t p-4">
          <ModalActions
            primary={{
              label: 'Select model',
              onClick: handleSelectButton,
            }}
          />
        </div>
      </div>
    </ModalOverlay>
  );
}
