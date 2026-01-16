import * as React from 'react';
import { Button } from '@lome-chat/ui';
import type { Model } from '@lome-chat/shared';
import { shortenModelName } from '@lome-chat/shared';
import { ModelSelectorModal } from './model-selector-modal';

interface ModelSelectorButtonProps {
  models: Model[];
  selectedId: string;
  /** Fallback name to display before models load (prevents flash) */
  selectedName?: string | undefined;
  onSelect: (modelId: string, modelName: string) => void;
  disabled?: boolean | undefined;
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
 * Button that opens the model selector modal.
 * Displays the selected model name.
 */
export function ModelSelectorButton({
  models,
  selectedId,
  selectedName,
  onSelect,
  disabled = false,
  premiumIds,
  canAccessPremium = true,
  isAuthenticated = true,
  onPremiumClick,
}: ModelSelectorButtonProps): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);

  const selectedModel = models.find((m) => m.id === selectedId);
  const rawName = selectedModel?.name ?? selectedName ?? 'Select model';
  const displayText = rawName === 'Select model' ? rawName : shortenModelName(rawName);

  const handleSelect = (modelId: string): void => {
    const model = models.find((m) => m.id === modelId);
    onSelect(modelId, model?.name ?? modelId);
  };

  const handleClick = (): void => {
    if (!disabled) {
      setIsOpen(true);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={handleClick}
        disabled={disabled}
        aria-label="Select model"
        data-testid="model-selector-button"
        className="bg-secondary hover:bg-secondary/80 mx-2 w-[250px] justify-center"
      >
        <span className="truncate">{displayText}</span>
      </Button>

      <ModelSelectorModal
        open={isOpen}
        onOpenChange={setIsOpen}
        models={models}
        selectedId={selectedId}
        onSelect={handleSelect}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        onPremiumClick={onPremiumClick}
      />
    </>
  );
}
