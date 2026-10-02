import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from '@/stores/model';
import { modelSelectionLabel } from '@/lib/chat/model-info-facts';
import { modelSwatch } from '@/lib/utils/model-color';
import { ModelChip } from '@/components/shared/model-chip';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';
import type { Model, ChatModality } from '@hushbox/shared';
import type { PickerConversationContext } from '@/components/chat/model-selector/model-selector-types';
import type { ModelSelectorGatingProps } from '@/components/chat/model-selector/model-selector-types';

interface ModelSelectorButtonProps extends ModelSelectorGatingProps {
  models: Model[];
  selectedModels: { id: string; name: string }[];
  onSelect: (models: { id: string; name: string }[]) => void;
  activeModality?: ChatModality;
  /** Group funding context for the modal's affordability floor (threading only). */
  floorGroup?: PickerConversationContext | undefined;
}

interface ChipLabels {
  readonly label: string;
  readonly shortLabel: string | undefined;
  readonly count: string | undefined;
}

/**
 * One model reads as its name, shortened only in a compact composer. Several read as the
 * selection label, split so the name can truncate while the count of further models stays
 * whole: the count is what the several-model label adds to the one-model label. A short
 * label equal to the label is left out, so the chip carries its text once.
 */
function chipLabels(firstName: string, selectionCount: number): ChipLabels {
  const name = modelSelectionLabel(firstName, 1);
  if (selectionCount > 1) {
    const selection = modelSelectionLabel(firstName, selectionCount);
    return { label: name, shortLabel: undefined, count: selection.slice(name.length) };
  }
  return { label: firstName, shortLabel: name === firstName ? undefined : name, count: undefined };
}

/** The first selected model's name, from the catalog while it is loaded. */
function firstModelName(
  models: Model[],
  firstEntry: { id: string; name: string } | undefined
): string {
  if (firstEntry === undefined) return DEFAULT_MODEL_NAME;
  return models.find((m) => m.id === firstEntry.id)?.name ?? firstEntry.name;
}

/** The composer's model chip, which opens the model picker. */
export function ModelSelectorButton({
  models,
  selectedModels,
  onSelect,
  premiumIds,
  isAuthenticated = true,
  isLinkGuest = false,
  onPremiumClick,
  activeModality = 'text',
  floorGroup,
}: Readonly<ModelSelectorButtonProps>): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);

  const firstEntry = selectedModels[0];
  const { label, shortLabel, count } = chipLabels(
    firstModelName(models, firstEntry),
    selectedModels.length
  );

  const selectedIds = React.useMemo(
    () => new Set(selectedModels.map((m) => m.id)),
    [selectedModels]
  );

  return (
    <>
      <ModelChip
        id="model-selector-button"
        data-testid={TEST_IDS.modelSelectorButton}
        swatch={modelSwatch(firstEntry?.id ?? DEFAULT_MODEL_ID)}
        label={label}
        {...(shortLabel !== undefined && { shortLabel })}
        {...(count !== undefined && { count })}
        expanded={isOpen}
        onClick={() => {
          setIsOpen(true);
        }}
      />

      <ModelSelectorModal
        open={isOpen}
        onOpenChange={setIsOpen}
        models={models}
        selectedIds={selectedIds}
        onSelect={onSelect}
        premiumIds={premiumIds}
        isAuthenticated={isAuthenticated}
        isLinkGuest={isLinkGuest}
        onPremiumClick={onPremiumClick}
        activeModality={activeModality}
        floorGroup={floorGroup}
      />
    </>
  );
}
