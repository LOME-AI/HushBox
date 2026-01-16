import * as React from 'react';
import { Search, ChevronUp, ChevronDown, Lock } from 'lucide-react';
import { ModalOverlay, Input, Badge, Button, ScrollArea } from '@lome-chat/ui';
import type { Model } from '@lome-chat/shared';
import {
  formatNumber,
  getModelCostPer1k,
  isExpensiveModel,
  shortenModelName,
} from '@lome-chat/shared';
import { applyFees, formatContextLength, formatPricePer1k } from '../../lib/format';
import { getAccessibleModelIds } from '../../hooks/models';
import { useIsMobile } from '../../hooks/use-is-mobile';

type SortField = 'price' | 'context' | null;
type SortDirection = 'asc' | 'desc';

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
}: ModelSelectorModalProps): React.JSX.Element {
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
    let result = models;

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (model) =>
          model.name.toLowerCase().includes(query) || model.provider.toLowerCase().includes(query)
      );
    }

    // Sort if a sort field is active
    if (sortField) {
      result = [...result].sort((a, b) => {
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

    // Interlace basic and premium models for non-paid users (always, including during sorting)
    // Paid users see no interlacing and no visual distinction
    if (!canAccessPremium && premiumIds && premiumIds.size > 0) {
      const basic = result.filter((m) => !premiumIds.has(m.id));
      const premium = result.filter((m) => premiumIds.has(m.id));
      const interlaced: Model[] = [];
      const maxLen = Math.max(basic.length, premium.length);
      for (let i = 0; i < maxLen; i++) {
        const basicModel = basic[i];
        const premiumModel = premium[i];
        if (basicModel) interlaced.push(basicModel);
        if (premiumModel) interlaced.push(premiumModel);
      }
      result = interlaced;
    }

    return result;
  }, [models, searchQuery, sortField, sortDirection, premiumIds, canAccessPremium]);

  const handleSortClick = React.useCallback(
    (field: 'price' | 'context'): void => {
      if (sortField === field) {
        // Toggle direction if same field
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
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
        className="bg-background flex h-[90vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border shadow-lg sm:h-[80vh]"
        data-testid="model-selector-modal"
      >
        {/* Main content area */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Fixed sections - MOBILE ONLY (outside flex competition) */}
          <div className="flex-shrink-0 sm:hidden">
            {/* Search input */}
            <div className="border-border-strong border-b p-4">
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                <Input
                  type="text"
                  placeholder="Search models"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                  }}
                  className="pl-9"
                />
              </div>
            </div>

            {/* Quick select buttons */}
            <div className="border-border-strong border-b p-4">
              <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                Quick Select Model
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    handleQuickSelect(strongestId);
                  }}
                  className="flex-1"
                  data-testid="quick-select-strongest"
                >
                  Strongest
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    handleQuickSelect(valueId);
                  }}
                  className="flex-1"
                  data-testid="quick-select-value"
                >
                  Value
                </Button>
              </div>
            </div>

            {/* Sort by section */}
            <div className="border-border-strong border-b p-4">
              <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                Sort By
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={sortField === 'price' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    handleSortClick('price');
                  }}
                  className="gap-1"
                  data-active={sortField === 'price'}
                  data-direction={sortField === 'price' ? sortDirection : undefined}
                >
                  Price
                  {sortField === 'price' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    ))}
                </Button>
                <Button
                  variant={sortField === 'context' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    handleSortClick('context');
                  }}
                  className="gap-1"
                  data-active={sortField === 'context'}
                  data-direction={sortField === 'context' ? sortDirection : undefined}
                >
                  Capacity
                  {sortField === 'context' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    ))}
                </Button>
              </div>
            </div>
          </div>

          {/* Split area - model list and info compete here */}
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            {/* Left panel: Model list (with fixed sections on desktop) */}
            <div
              data-testid="model-list-panel"
              className="border-border-strong flex min-h-0 flex-[2] flex-col border-b sm:flex-1 sm:border-r sm:border-b-0"
            >
              {/* Fixed sections - DESKTOP ONLY */}
              <div className="hidden flex-shrink-0 sm:block">
                {/* Search input */}
                <div className="border-border-strong border-b p-4">
                  <div className="relative">
                    <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                    <Input
                      type="text"
                      placeholder="Search models"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                      }}
                      className="pl-9"
                    />
                  </div>
                </div>

                {/* Quick select buttons */}
                <div className="border-border-strong border-b p-4">
                  <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                    Quick Select Model
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleQuickSelect(strongestId);
                      }}
                      className="flex-1"
                      data-testid="quick-select-strongest-desktop"
                    >
                      Strongest
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleQuickSelect(valueId);
                      }}
                      className="flex-1"
                      data-testid="quick-select-value-desktop"
                    >
                      Value
                    </Button>
                  </div>
                </div>

                {/* Sort by section */}
                <div className="border-border-strong border-b p-4">
                  <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                    Sort By
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant={sortField === 'price' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        handleSortClick('price');
                      }}
                      className="gap-1"
                      data-active={sortField === 'price'}
                      data-direction={sortField === 'price' ? sortDirection : undefined}
                    >
                      Price
                      {sortField === 'price' &&
                        (sortDirection === 'asc' ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        ))}
                    </Button>
                    <Button
                      variant={sortField === 'context' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        handleSortClick('context');
                      }}
                      className="gap-1"
                      data-active={sortField === 'context'}
                      data-direction={sortField === 'context' ? sortDirection : undefined}
                    >
                      Capacity
                      {sortField === 'context' &&
                        (sortDirection === 'asc' ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        ))}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Model list */}
              <ScrollArea data-testid="model-list-scroll" className="min-h-0 flex-1">
                <div className="p-2">
                  {filteredModels.map((model) => {
                    const modelIsPremium = isPremium(model.id);
                    const showOverlay = modelIsPremium && !canAccessPremium;
                    const accessMessage = !isAuthenticated
                      ? 'Sign up to access'
                      : 'Add credits to unlock';

                    return (
                      <div
                        key={model.id}
                        data-testid={`model-item-${model.id}`}
                        data-selected={model.id === focusedModelId}
                        onClick={() => {
                          handleModelClick(model.id);
                        }}
                        onDoubleClick={() => {
                          handleModelDoubleClick(model.id);
                        }}
                        className={`relative cursor-pointer rounded-md p-3 transition-colors ${
                          model.id === focusedModelId
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-muted'
                        }`}
                        role="option"
                        aria-selected={model.id === focusedModelId}
                      >
                        {showOverlay && (
                          <div
                            data-testid="premium-overlay"
                            className="bg-background/60 pointer-events-none absolute inset-0 rounded-md"
                          />
                        )}

                        <div className="relative flex items-center justify-between gap-2">
                          <span className="truncate font-medium">
                            {shortenModelName(model.name)}
                          </span>
                          {showOverlay && (
                            <Lock
                              data-testid="lock-icon"
                              className="text-muted-foreground h-4 w-4 shrink-0"
                            />
                          )}
                        </div>
                        <div className="text-muted-foreground relative flex items-center justify-between text-xs">
                          <span className="truncate">
                            {model.provider} • {formatContextLength(model.contextLength)}
                          </span>
                          {showOverlay && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              {accessMessage}
                            </span>
                          )}
                        </div>
                      </div>
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
              className="min-h-0 flex-[3] sm:max-w-sm sm:flex-1"
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
          <Button variant="default" onClick={handleSelectButton} className="w-full">
            Select model
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
