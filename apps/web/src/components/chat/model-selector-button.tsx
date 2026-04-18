import * as React from 'react';
import { Button } from '@hushbox/ui';
import type { Model, Modality } from '@hushbox/shared';
import { shortenModelName } from '@hushbox/shared';
import { DEFAULT_MODEL_NAME } from '@/stores/model';
import { ModelSelectorModal } from './model-selector-modal';
import type { ModelSelectorGatingProps } from './model-selector-types';

function getModelDisplayText(
  selectedModels: { id: string; name: string }[],
  selectedModel: Model | undefined,
  firstEntry: { id: string; name: string } | undefined
): string {
  if (selectedModels.length > 1) {
    return 'Multiple Models';
  }
  const rawName = selectedModel?.name ?? firstEntry?.name ?? DEFAULT_MODEL_NAME;
  return shortenModelName(rawName);
}

export interface ModelSelectorButtonProps extends ModelSelectorGatingProps {
  models: Model[];
  selectedModels: { id: string; name: string }[];
  onSelect: (models: { id: string; name: string }[]) => void;
  disabled?: boolean | undefined;
  activeModality?: Modality;
}

/**
 * Button that opens the model selector modal.
 * Displays the selected model name, or "Multiple Models" when 2+ are selected.
 */
export function ModelSelectorButton({
  models,
  selectedModels,
  onSelect,
  disabled = false,
  premiumIds,
  canAccessPremium = true,
  isAuthenticated = true,
  isLinkGuest = false,
  onPremiumClick,
  activeModality = 'text',
}: Readonly<ModelSelectorButtonProps>): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);

  const firstEntry = selectedModels[0];
  const selectedId = firstEntry?.id ?? '';
  const selectedModel = models.find((m) => m.id === selectedId);
  const displayText = getModelDisplayText(selectedModels, selectedModel, firstEntry);

  const selectedIds = React.useMemo(
    () => new Set(selectedModels.map((m) => m.id)),
    [selectedModels]
  );

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
        className="bg-secondary hover:bg-secondary/80 mx-2 justify-center px-6"
      >
        <span>{displayText}</span>
      </Button>

      <ModelSelectorModal
        open={isOpen}
        onOpenChange={setIsOpen}
        models={models}
        selectedIds={selectedIds}
        onSelect={onSelect}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        isLinkGuest={isLinkGuest}
        onPremiumClick={onPremiumClick}
        activeModality={activeModality}
      />
    </>
  );
}
